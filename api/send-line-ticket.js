function getBaseUrl(request) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const proto = request.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

function asTicketUrl(baseUrl, code) {
  return `${baseUrl}/api/qr?code=${encodeURIComponent(code)}`;
}

function buildMessages(baseUrl, ticket) {
  const codes = Array.isArray(ticket.codes) ? ticket.codes : [];
  const eventDate = formatEventDate(ticket.event_day);
  const header = [
    `บัตรคอนเสิร์ต ${ticket.ticket_id}`,
    `ประเภท: ${ticket.ticket_type}`,
    `วันงาน: ${eventDate}`,
    ticket.buyer_name ? `ลูกค้า: ${ticket.buyer_name}` : "",
    ticket.perks ? `สิทธิ์ VIP: ${ticket.perks}` : "",
    "",
    "แสดง QR นี้ที่จุดเข้างาน",
  ].filter(Boolean).join("\n");

  const imageMessages = codes.slice(0, 4).map((code) => ({
    type: "image",
    originalContentUrl: asTicketUrl(baseUrl, code),
    previewImageUrl: asTicketUrl(baseUrl, code),
  }));

  return [
    { type: "text", text: `${header}\nรหัส QR: ${codes.join(", ")}` },
    ...imageMessages,
  ];
}

function formatEventDate(value) {
  const legacyMap = {
    "Day 1": "2026-08-27",
    "Day 2": "2026-08-28",
    "Day 3": "2026-08-30",
    "Day 4": "2026-09-06",
  };
  const normalized = legacyMap[value] || value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized || "-";

  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${normalized}T00:00:00+07:00`));
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const expectedPin = process.env.ADMIN_PIN;
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!expectedPin || !lineToken) {
    response.status(500).json({ error: "Missing ADMIN_PIN or LINE_CHANNEL_ACCESS_TOKEN" });
    return;
  }

  if (request.headers["x-admin-pin"] !== expectedPin) {
    response.status(401).json({ error: "รหัสแอดมินไม่ถูกต้อง" });
    return;
  }

  const { to, ticket } = request.body || {};
  if (!to || !ticket || !Array.isArray(ticket.codes) || ticket.codes.length === 0) {
    response.status(400).json({ error: "Missing LINE userId or ticket codes" });
    return;
  }

  const lineResponse = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lineToken}`,
    },
    body: JSON.stringify({
      to,
      messages: buildMessages(getBaseUrl(request), ticket),
    }),
  });

  if (!lineResponse.ok) {
    const details = await lineResponse.text();
    response.status(lineResponse.status).json({ error: "LINE push message failed", details });
    return;
  }

  response.status(200).json({ ok: true });
};
