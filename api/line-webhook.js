const crypto = require("crypto");

exports.config = {
  api: {
    bodyParser: false,
  },
};

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function verifySignature(rawBody, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  if (Buffer.byteLength(digest) !== Buffer.byteLength(signature)) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

async function getLineProfile(userId) {
  const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
  });

  if (!response.ok) return { userId };
  return response.json();
}

const REGISTRATION_REPLY_TEXT =
  "รับข้อมูลแล้วค่ะ ต้องการซื้อบัตรคอนเสิร์ตวันไหนแจ้งแอดมินได้เลยค่ะ หรือสอบถามรายละเอียดได้เลยค่ะ\nเมื่อตรวจสอบการชำระเงินเรียบร้อย ทีมงานจะส่ง QR บัตรคอนเสิร์ตให้ทางแชทนี้";

async function updateCustomer(userId, payload) {
  const params = new URLSearchParams({
    line_user_id: `eq.${userId}`,
  });

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/line_customers?${params}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });
}

async function upsertCustomer(event) {
  const userId = event.source?.userId;
  if (!userId) return false;

  const profile = await getLineProfile(userId);
  const payload = {
    line_user_id: userId,
    display_name: profile.displayName || null,
    picture_url: profile.pictureUrl || null,
    last_event_type: event.type,
    followed_at: event.type === "follow" ? new Date().toISOString() : undefined,
    last_seen_at: new Date().toISOString(),
  };

  const createResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/line_customers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });

  if (createResponse.status === 201) return true;

  await updateCustomer(userId, payload);
  return false;
}

async function replyRegistration(event) {
  if (!event.replyToken || event.replyToken === "00000000000000000000000000000000") return;

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text: REGISTRATION_REPLY_TEXT,
        },
      ],
    }),
  });
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawBody = await readRawBody(request);
  const signature = request.headers["x-line-signature"] || request.headers["X-Line-Signature"];

  if (!verifySignature(rawBody, signature)) {
    response.status(401).json({ error: "Invalid LINE signature" });
    return;
  }

  const body = JSON.parse(rawBody.toString("utf8"));
  const events = Array.isArray(body.events) ? body.events : [];
  const repliedUserIds = new Set();

  for (const event of events) {
    const userId = event.source?.userId;
    const isNewCustomer = await upsertCustomer(event);
    if (isNewCustomer && userId && !repliedUserIds.has(userId) && (event.type === "follow" || event.type === "message")) {
      await replyRegistration(event);
      repliedUserIds.add(userId);
    }
  }

  response.status(200).json({ ok: true });
};
