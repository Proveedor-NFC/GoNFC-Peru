// Recibe un pedido terminado de la tienda y lo crea en Shopify (pago pendiente de verificar).
// Claves (variables de entorno en Netlify): SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
const API_VERSION = "2025-10";
const HEADERS = { "Content-Type": "application/json" };
const res = (code, obj) => ({ statusCode: code, headers: HEADERS, body: JSON.stringify(obj) });
const clean = (v, n = 200) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

let cached = { token: null, exp: 0 };
async function getToken(shop) {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const r = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET
    })
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("token: " + (j.error_description || j.error || r.status));
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return cached.token;
}

const MUTATION = `mutation($order: OrderCreateOrderInput!) {
  orderCreate(order: $order) {
    order { id name }
    userErrors { field message }
  }
}`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "método no permitido" });
  const shop = clean(process.env.SHOPIFY_STORE);
  if (!shop || !process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) return res(500, { error: "falta configurar las claves" });
  let d;
  try { d = JSON.parse(event.body || "{}"); } catch (e) { return res(400, { error: "datos inválidos" }); }

  const lines = Array.isArray(d.lines) ? d.lines.slice(0, 30) : [];
  if (!lines.length || !d.id || !d.addr) return res(400, { error: "pedido incompleto" });
  const a = d.addr, fullName = clean(d.name, 100), parts = fullName.split(/\s+/);
  const first = parts.slice(0, Math.max(1, parts.length - 2)).join(" "), last = parts.slice(-2).join(" ");
  const phone = "+51" + clean(a.tel, 9).replace(/\D/g, "");
  const method = { yape: "Yape / Plin", transfer: "Transferencia (BBVA / CCI)" }[d.method] || clean(d.method, 40);

  const shipping = {
    firstName: first, lastName: parts.length > 1 ? last : "-",
    address1: clean(a.dir, 250), address2: `Departamento: ${clean(a.dep, 80)} · Provincia: ${clean(a.prov, 80)} · Distrito: ${clean(a.dist, 80)}`,
    city: clean(a.dist, 80), countryCode: "PE", phone
  };
  if (clean(a.zip, 10) && clean(a.zip, 10) !== "—") shipping.zip = clean(a.zip, 10);
  const note = [
    `PAGO POR VERIFICAR · ${method}`,
    `N.° de operación: ${clean(d.op, 40)}`,
    `Nombre de la cuenta que pagó: ${clean(d.who, 100)}`,
    `Recibe el pedido: ${fullName}`,
    `Total cobrado: S/ ${Number(d.total).toFixed(2)}`,
    d.coupon ? `Cupón: ${clean(d.coupon, 30)}` : "",
    `Pedido de la tienda: ${clean(d.id, 40)}`
  ].filter(Boolean).join("\n");

  const order = {
    currency: "PEN",
    sourceIdentifier: clean(d.id, 60),
    email: clean(d.email, 120) || undefined,
    phone,
    note,
    tags: ["tienda-web", "pago-por-verificar", d.method === "yape" ? "yape-plin" : "transferencia"],
    financialStatus: "PENDING",
    shippingAddress: shipping,
    billingAddress: shipping,
    customAttributes: [
      { key: "Método de pago", value: method },
      { key: "N.° de operación", value: clean(d.op, 40) },
      { key: "Cuenta que pagó", value: clean(d.who, 100) },
      { key: "Recibe", value: fullName }
    ],
    lineItems: lines.map(l => ({
      title: clean(l.title, 200) || "Producto",
      quantity: Math.max(1, Math.min(500, parseInt(l.qty, 10) || 1)),
      requiresShipping: true,
      priceSet: { shopMoney: { amount: Math.max(0, Number(l.unit) || 0).toFixed(2), currencyCode: "PEN" } }
    }))
  };

  try {
    const token = await getToken(shop);
    const r = await fetch(`https://${shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: MUTATION, variables: { order } })
    });
    const j = await r.json();
    const out = j.data && j.data.orderCreate;
    if (!r.ok || j.errors || !out || (out.userErrors && out.userErrors.length)) {
      console.error("Shopify:", JSON.stringify(j.errors || (out && out.userErrors) || j));
      return res(502, { error: "no se pudo crear el pedido" });
    }
    return res(200, { ok: true, order: out.order.name });
  } catch (e) {
    console.error(e.message);
    return res(502, { error: "error al conectar con Shopify" });
  }
};
