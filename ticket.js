const APP_CONFIG = window.APP_CONFIG || {};
const EVENT_DATES = ["2026-08-27", "2026-08-28", "2026-08-30", "2026-09-06"];
const db = APP_CONFIG.supabaseUrl && APP_CONFIG.supabaseAnonKey
  ? window.supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey)
  : null;

document.addEventListener("DOMContentLoaded", async () => {
  document.querySelector("#printCustomerTicket").addEventListener("click", () => window.print());
  const ticketId = new URLSearchParams(window.location.search).get("id");
  if (!ticketId || !db) {
    showTicketError("ไม่พบบัตร");
    return;
  }

  const { data, error } = await db
    .from("tickets")
    .select("id,ticket_type,event_day,buyer_name,price,capacity,perks,ticket_codes(code,seat_no,checked_in_at)")
    .eq("id", ticketId)
    .single();

  if (error || !data) {
    showTicketError("ไม่พบบัตรหรือโหลดข้อมูลไม่สำเร็จ");
    return;
  }

  renderTicket(data);
});

function renderTicket(ticket) {
  const codes = [...ticket.ticket_codes].sort((a, b) => a.seat_no - b.seat_no);
  document.querySelector("#ticketTitle").textContent = `${ticket.id} · ${ticket.ticket_type}`;
  document.querySelector("#ticketDetails").innerHTML = `
    <p>วันงาน: <strong>${formatEventDate(ticket.event_day)}</strong></p>
    <p>ลูกค้า: ${escapeHtml(ticket.buyer_name || "-")}</p>
    <p>จำนวน: ${ticket.capacity} คน · ราคา ${Number(ticket.price).toLocaleString("th-TH")} บาท</p>
    ${ticket.perks ? `<p>สิทธิ์ VIP: ${ticket.perks}</p>` : ""}
  `;

  const list = document.querySelector("#customerQrList");
  list.innerHTML = "";
  codes.forEach((qr) => {
    const item = document.createElement("article");
    item.className = "customer-qr-card";
    item.innerHTML = `
      <div class="qr-box qr-box-large" data-qr="${qr.code}"></div>
      <strong>${qr.code}</strong>
      <span>${qr.checked_in_at ? "เช็คอินแล้ว" : "ยังไม่เช็คอิน"}</span>
    `;
    list.appendChild(item);
  });
  renderQrCodes();
}

function renderQrCodes() {
  document.querySelectorAll("[data-qr]").forEach((box) => {
    const code = box.dataset.qr;
    box.innerHTML = "";
    new QRCode(box, { text: code, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
  });
}

function showTicketError(message) {
  document.querySelector("#ticketTitle").textContent = message;
  document.querySelector("#ticketDetails").innerHTML = "";
  document.querySelector("#customerQrList").innerHTML = "";
}

function normalizeEventDate(value) {
  if (EVENT_DATES.includes(value)) return value;
  const legacyMap = {
    "Day 1": "2026-08-27",
    "Day 2": "2026-08-28",
    "Day 3": "2026-08-30",
    "Day 4": "2026-09-06",
  };
  return legacyMap[value] || "";
}

function formatEventDate(value) {
  const normalized = normalizeEventDate(value) || value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized || "-";
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${normalized}T00:00:00+07:00`));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
