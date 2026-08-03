const VIP_LIMIT = 30;
const EVENT_DATES = ["2026-08-27", "2026-08-28", "2026-08-30", "2026-09-06"];
const APP_CONFIG = window.APP_CONFIG || {};
const currentDayKey = "concert-current-day";

let currentDay = normalizeEventDate(localStorage.getItem(currentDayKey)) || EVENT_DATES[0];
let tickets = [];
let checkins = [];
let lineCustomers = [];
let scannerStream = null;
let scannerTimer = null;
let detector = null;
let lastScanValue = "";
let lastScanAt = 0;

const elements = {
  setupWarning: document.querySelector("#setupWarning"),
  dayButtons: document.querySelectorAll("[data-current-day]"),
  activeDayBadge: document.querySelector("#activeDayBadge"),
  todayCheckins: document.querySelector("#todayCheckins"),
  totalCheckins: document.querySelector("#totalCheckins"),
  totalIssued: document.querySelector("#totalIssued"),
  vipRemaining: document.querySelector("#vipRemaining"),
  issueForm: document.querySelector("#issueForm"),
  ticketType: document.querySelector("#ticketType"),
  ticketPrice: document.querySelector("#ticketPrice"),
  ticketQuantity: document.querySelector("#ticketQuantity"),
  eventDay: document.querySelector("#eventDay"),
  buyerName: document.querySelector("#buyerName"),
  lineUserId: document.querySelector("#lineUserId"),
  lineCustomerList: document.querySelector("#lineCustomerList"),
  adminPin: document.querySelector("#adminPin"),
  sendLine: document.querySelector("#sendLine"),
  ticketList: document.querySelector("#ticketList"),
  checkinLog: document.querySelector("#checkinLog"),
  manualCheckinForm: document.querySelector("#manualCheckinForm"),
  manualCode: document.querySelector("#manualCode"),
  staffName: document.querySelector("#staffName"),
  scanResult: document.querySelector("#scanResult"),
  startScanner: document.querySelector("#startScanner"),
  stopScanner: document.querySelector("#stopScanner"),
  scannerVideo: document.querySelector("#scannerVideo"),
  scannerPlaceholder: document.querySelector("#scannerPlaceholder"),
  refreshData: document.querySelector("#refreshData"),
};

const supabaseReady = Boolean(APP_CONFIG.supabaseUrl && APP_CONFIG.supabaseAnonKey);
const db = supabaseReady
  ? window.supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey)
  : null;

document.addEventListener("DOMContentLoaded", async () => {
  wireEvents();
  renderDayControls();
  updateQuantityState();

  if (!supabaseReady) {
    elements.setupWarning.hidden = false;
    showResult("ยังไม่ได้ตั้งค่า Supabase ใน config.js", "warning");
    render();
    return;
  }

  await loadData();
  subscribeToChanges();
});

function wireEvents() {
  elements.dayButtons.forEach((button) => {
    button.addEventListener("click", () => {
      currentDay = normalizeEventDate(button.dataset.currentDay) || EVENT_DATES[0];
      localStorage.setItem(currentDayKey, currentDay);
      render();
    });
  });

  elements.issueForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await issueTicket();
  });
  elements.ticketType.addEventListener("change", updateQuantityState);
  elements.ticketList.addEventListener("click", handleTicketAction);

  elements.manualCheckinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await checkIn(elements.manualCode.value);
    elements.manualCode.value = "";
  });

  elements.startScanner.addEventListener("click", startScanner);
  elements.stopScanner.addEventListener("click", stopScanner);
  elements.refreshData.addEventListener("click", loadData);
}

async function loadData() {
  if (!db) return;
  showResult("กำลังโหลดข้อมูลจากฐานข้อมูลกลาง", "neutral");

  const [ticketResult, checkinResult] = await Promise.all([
    db
      .from("tickets")
      .select("id,ticket_type,event_day,buyer_name,line_user_id,price,capacity,perks,issued_at,ticket_codes(code,seat_no,checked_in_at,staff_name)")
      .order("issued_at", { ascending: false }),
    db
      .from("checkins")
      .select("code,ticket_id,ticket_type,event_day,staff_name,checked_in_at")
      .order("checked_in_at", { ascending: false })
      .limit(200),
    loadLineCustomers(),
  ]);

  if (ticketResult.error || checkinResult.error) {
    showResult(ticketResult.error?.message || checkinResult.error?.message || "โหลดข้อมูลไม่สำเร็จ", "error");
    return;
  }

  tickets = ticketResult.data || [];
  checkins = checkinResult.data || [];
  render();
  showResult("พร้อมใช้งาน", "neutral");
}

async function loadLineCustomers() {
  const { data, error } = await db
    .from("line_customers")
    .select("line_user_id,display_name,last_seen_at")
    .order("last_seen_at", { ascending: false })
    .limit(300);

  if (!error) lineCustomers = data || [];
}

function subscribeToChanges() {
  db.channel("concert-ticket-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, loadData)
    .on("postgres_changes", { event: "*", schema: "public", table: "ticket_codes" }, loadData)
    .on("postgres_changes", { event: "*", schema: "public", table: "checkins" }, loadData)
    .on("postgres_changes", { event: "*", schema: "public", table: "line_customers" }, loadData)
    .subscribe();
}

async function issueTicket() {
  if (!db) {
    showResult("ยังไม่ได้เชื่อมต่อ Supabase", "error");
    return;
  }

  const ticketType = elements.ticketType.value;
  const eventDay = elements.eventDay.value;
  const buyerName = elements.buyerName.value.trim() || "-";
  const lineUserId = elements.lineUserId.value.trim();
  const adminPin = elements.adminPin.value.trim();
  const ticketPrice = ticketType === "Regular" ? clampRegularPrice(elements.ticketPrice.value) : null;
  const quantity = ticketType === "Regular" ? clampQuantity(elements.ticketQuantity.value) : 1;
  const issuedTickets = [];

  if (elements.sendLine.checked && !adminPin) {
    showResult("กรุณากรอกรหัสแอดมินก่อนออกบัตรและส่ง LINE OA", "warning");
    elements.adminPin.focus();
    return;
  }

  showResult(`กำลังสร้างบัตร ${quantity} ใบ`, "neutral");
  for (let index = 0; index < quantity; index += 1) {
    const numberedName = quantity > 1 ? `${buyerName} #${index + 1}` : buyerName;
    const { data, error } = await db.rpc("issue_ticket", {
      p_ticket_type: ticketType,
      p_event_day: eventDay,
      p_buyer_name: numberedName,
      p_line_user_id: lineUserId || null,
      p_ticket_price: ticketPrice,
    });

    if (error) {
      showResult(error.message, "error");
      await loadData();
      return;
    }

    issuedTickets.push(data);
  }

  await loadData();

  if (elements.sendLine.checked && lineUserId) {
    for (const issuedTicket of issuedTickets) {
      await sendTicketToLine(lineUserId, issuedTicket);
    }
  } else {
    const ticketIds = issuedTickets.map((ticket) => ticket.ticket_id).join(", ");
    showResult(`สร้างบัตร ${ticketIds} แล้ว`, "success");
  }

  elements.buyerName.value = "";
  elements.lineUserId.value = "";
}

async function sendTicketToLine(lineUserId, ticket) {
  const adminPin = elements.adminPin.value.trim();
  if (!adminPin) {
    showResult("ไม่ได้ส่ง LINE เพราะไม่ได้กรอกรหัสแอดมิน", "warning");
    return;
  }

  showResult("กำลังส่ง QR ทาง LINE OA", "neutral");
  const response = await fetch("/api/send-line-ticket", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-pin": adminPin,
    },
    body: JSON.stringify({
      to: lineUserId,
      ticket,
    }),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    showResult(result.error || "ส่ง LINE ไม่สำเร็จ", "error");
    return;
  }

  showResult(`สร้างบัตร ${ticket.ticket_id} และส่ง QR ทาง LINE แล้ว`, "success");
}

async function checkIn(rawCode) {
  const code = normalizeScannedValue(rawCode);
  if (!code) {
    showResult("กรุณากรอกรหัส QR", "warning");
    return;
  }

  const staffName = elements.staffName.value.trim() || "ไม่ระบุ";
  const { data, error } = await db.rpc("check_in_ticket", {
    p_code: code,
    p_current_day: currentDay,
    p_staff_name: staffName,
  });

  if (error) {
    showResult(error.message, "error");
    return;
  }

  if (data.status === "not_found") {
    showResult(`ไม่พบบัตร ${code}`, "error");
    return;
  }

  if (data.status === "wrong_day") {
    showResult(`บัตรนี้ใช้สำหรับ ${formatEventDate(data.event_day)} ไม่อนุญาตให้เข้า`, "error");
    return;
  }

  if (data.status === "already_checked_in") {
    const time = new Date(data.checked_in_at).toLocaleString("th-TH");
    showResult(`${code} เช็คอินไปแล้ว เวลา ${time} โดย ${data.staff_name || "-"}`, "warning");
    return;
  }

  await loadData();
  showResult(`อนุญาตให้เข้า: ${code} (${formatEventDate(currentDay)})`, "success");
}

async function startScanner() {
  if (!("BarcodeDetector" in window)) {
    showResult("เบราว์เซอร์นี้ยังไม่รองรับการสแกน QR จากกล้อง กรุณากรอกรหัสแทน", "warning");
    return;
  }

  try {
    detector = new BarcodeDetector({ formats: ["qr_code"] });
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    elements.scannerVideo.srcObject = scannerStream;
    elements.scannerPlaceholder.style.display = "none";
    await elements.scannerVideo.play();
    scannerTimer = window.setInterval(scanFrame, 650);
    showResult("เปิดกล้องแล้ว พร้อมสแกน", "neutral");
  } catch {
    showResult("เปิดกล้องไม่ได้ กรุณาอนุญาตสิทธิ์กล้องหรือกรอกรหัสแทน", "error");
  }
}

function stopScanner() {
  if (scannerTimer) window.clearInterval(scannerTimer);
  scannerTimer = null;
  if (scannerStream) scannerStream.getTracks().forEach((track) => track.stop());
  scannerStream = null;
  elements.scannerVideo.srcObject = null;
  elements.scannerPlaceholder.style.display = "grid";
}

async function scanFrame() {
  if (!detector || !elements.scannerVideo.videoWidth) return;

  try {
    const codes = await detector.detect(elements.scannerVideo);
    if (!codes.length) return;

    const value = codes[0].rawValue;
    const now = Date.now();
    if (value === lastScanValue && now - lastScanAt < 2500) return;

    lastScanValue = value;
    lastScanAt = now;
    await checkIn(value);
  } catch {
    showResult("อ่าน QR ไม่สำเร็จ ลองขยับกล้องหรือกรอกรหัสแทน", "warning");
  }
}

function render() {
  renderDayControls();
  renderMetrics();
  renderLineCustomers();
  renderTickets();
  renderCheckins();
}

function renderDayControls() {
  elements.dayButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.currentDay === currentDay);
  });
  elements.activeDayBadge.textContent = formatEventDate(currentDay);
}

function renderMetrics() {
  const todayCount = checkins.filter((item) => item.event_day === currentDay).length;
  const totalCodes = tickets.reduce((sum, ticket) => sum + ticket.ticket_codes.length, 0);
  const vipSold = tickets.filter((ticket) => ticket.ticket_type === "VIP").length;
  elements.todayCheckins.textContent = todayCount;
  elements.totalCheckins.textContent = checkins.length;
  elements.totalIssued.textContent = totalCodes;
  elements.vipRemaining.textContent = VIP_LIMIT - vipSold;
}

function renderLineCustomers() {
  elements.lineCustomerList.innerHTML = lineCustomers
    .map((customer) => {
      const label = customer.display_name ? `${customer.display_name} - ${customer.line_user_id}` : customer.line_user_id;
      return `<option value="${escapeHtml(customer.line_user_id)}" label="${escapeHtml(label)}"></option>`;
    })
    .join("");
}

function renderTickets() {
  if (!tickets.length) {
    elements.ticketList.innerHTML = `<p class="empty-state">ยังไม่มีบัตรที่ออก</p>`;
    return;
  }

  elements.ticketList.innerHTML = "";
  tickets.forEach((ticket) => {
    const codes = getSortedCodes(ticket);
    const card = document.createElement("article");
    card.className = "ticket-card";
    card.innerHTML = `
      <div class="ticket-qr-grid">
        ${codes.map((qr) => `
          <div class="ticket-qr-item">
            <div class="qr-box" data-qr="${qr.code}" aria-label="QR ${qr.code}"></div>
            <strong>${qr.code}</strong>
          </div>
        `).join("")}
      </div>
      <div class="ticket-meta">
        <h3>${ticket.id} · ${ticket.ticket_type}</h3>
        <p>วันบัตร: <strong>${formatEventDate(ticket.event_day)}</strong></p>
        <p>ลูกค้า: ${escapeHtml(ticket.buyer_name || "-")}</p>
        <p>LINE userId: ${escapeHtml(ticket.line_user_id || "-")}</p>
        <p>ราคา: ${Number(ticket.price).toLocaleString("th-TH")} บาท · จำนวน ${ticket.capacity} คน</p>
        ${ticket.perks ? `<p>สิทธิ์: ${ticket.perks}</p>` : ""}
        <div class="code-list">
          ${codes.map((qr) => `<span class="code-pill ${qr.checked_in_at ? "used" : ""}">${qr.code}</span>`).join("")}
        </div>
        <div class="ticket-actions">
          <button class="ghost-button" type="button" data-action="copy" data-ticket-id="${ticket.id}">คัดลอกรหัส QR</button>
          <button class="ghost-button" type="button" data-action="download" data-ticket-id="${ticket.id}">ดาวน์โหลด QR</button>
          <button class="ghost-button" type="button" data-action="print" data-ticket-id="${ticket.id}">พิมพ์บัตร</button>
          <button class="primary-button" type="button" data-action="open" data-ticket-id="${ticket.id}">เปิดหน้าลูกค้า</button>
        </div>
      </div>
    `;
    elements.ticketList.appendChild(card);
  });

  renderQrCodes();
}

function renderQrCodes() {
  document.querySelectorAll("[data-qr]").forEach((box) => {
    const code = box.dataset.qr;
    box.innerHTML = "";
    if (window.QRCode) {
      new QRCode(box, { text: code, width: 112, height: 112, correctLevel: QRCode.CorrectLevel.M });
      return;
    }
    box.textContent = code;
  });
}

function renderCheckins() {
  if (!checkins.length) {
    elements.checkinLog.innerHTML = `<tr><td colspan="4">ยังไม่มีประวัติเช็คอิน</td></tr>`;
    return;
  }

  elements.checkinLog.innerHTML = checkins
    .map((item) => `
      <tr>
        <td>${new Date(item.checked_in_at).toLocaleString("th-TH")}</td>
        <td>${item.code}</td>
        <td>${formatEventDate(item.event_day)}</td>
        <td>${escapeHtml(item.staff_name)}</td>
      </tr>
    `)
    .join("");
}

async function handleTicketAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const ticket = tickets.find((item) => item.id === button.dataset.ticketId);
  if (!ticket) return;

  if (button.dataset.action === "copy") {
    await copyTicketCodes(ticket);
  } else if (button.dataset.action === "download") {
    downloadTicketQrs(ticket);
  } else if (button.dataset.action === "print") {
    printTicket(ticket);
  } else if (button.dataset.action === "open") {
    window.open(getTicketUrl(ticket.id), "_blank", "noopener");
  }
}

async function copyTicketCodes(ticket) {
  const codes = getSortedCodes(ticket).map((qr) => qr.code).join("\n");
  await navigator.clipboard.writeText(codes);
  showResult(`คัดลอกรหัส QR ของ ${ticket.id} แล้ว`, "success");
}

function downloadTicketQrs(ticket) {
  getSortedCodes(ticket).forEach((qr, index) => {
    window.setTimeout(() => {
      const link = document.createElement("a");
      const canvas = document.querySelector(`[data-qr="${qr.code}"] canvas`);
      link.href = canvas ? canvas.toDataURL("image/png") : `/api/qr?code=${encodeURIComponent(qr.code)}`;
      link.download = `${qr.code}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }, index * 250);
  });
}

function printTicket(ticket) {
  const codes = getSortedCodes(ticket);
  const printWindow = window.open("", "_blank", "noopener,width=900,height=700");
  if (!printWindow) {
    showResult("เปิดหน้าพิมพ์ไม่ได้ กรุณาอนุญาต popup", "warning");
    return;
  }

  printWindow.document.write(`
    <!doctype html>
    <html lang="th">
      <head>
        <meta charset="utf-8" />
        <title>${ticket.id}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; color: #111827; }
          h1 { margin: 0 0 8px; }
          p { margin: 4px 0; }
          .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px; margin-top: 20px; }
          .qr { border: 1px solid #d0d5dd; padding: 14px; text-align: center; page-break-inside: avoid; }
          .qr img { width: 220px; height: 220px; }
          .code { display: block; margin-top: 10px; font-size: 18px; font-weight: 700; }
        </style>
      </head>
      <body>
        <h1>บัตรคอนเสิร์ต ${ticket.id}</h1>
        <p>ประเภท: ${ticket.ticket_type}</p>
        <p>วันงาน: ${formatEventDate(ticket.event_day)}</p>
        <p>ลูกค้า: ${escapeHtml(ticket.buyer_name || "-")}</p>
        ${ticket.perks ? `<p>สิทธิ์ VIP: ${ticket.perks}</p>` : ""}
        <div class="grid">
          ${codes.map((qr) => `
            <div class="qr">
              <img src="/api/qr?code=${encodeURIComponent(qr.code)}" alt="${qr.code}" />
              <span class="code">${qr.code}</span>
            </div>
          `).join("")}
        </div>
        <script>
          window.addEventListener("load", () => window.print());
        <\/script>
      </body>
    </html>
  `);
  printWindow.document.close();
}

function getSortedCodes(ticket) {
  return [...ticket.ticket_codes].sort((a, b) => a.seat_no - b.seat_no);
}

function getTicketUrl(ticketId) {
  return `${window.location.origin}/ticket.html?id=${encodeURIComponent(ticketId)}`;
}

function updateQuantityState() {
  const isRegular = elements.ticketType.value === "Regular";
  elements.ticketPrice.disabled = !isRegular;
  elements.ticketQuantity.disabled = !isRegular;
  elements.ticketPrice.value = isRegular ? elements.ticketPrice.value || "150" : "150";
  elements.ticketQuantity.value = isRegular ? elements.ticketQuantity.value || "1" : "1";
}

function clampQuantity(value) {
  const quantity = Number.parseInt(value, 10);
  if (Number.isNaN(quantity)) return 1;
  return Math.min(Math.max(quantity, 1), 50);
}

function clampRegularPrice(value) {
  const price = Number.parseInt(value, 10);
  return [150, 180].includes(price) ? price : 150;
}

function normalizeScannedValue(value) {
  return String(value || "").trim().toUpperCase();
}

function showResult(message, type) {
  elements.scanResult.textContent = message;
  elements.scanResult.className = `scan-result ${type}`;
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
