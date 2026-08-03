const VIP_LIMIT = 30;
const EVENT_DATES = ["2026-08-27", "2026-08-28", "2026-08-30", "2026-09-06"];
const APP_CONFIG = window.APP_CONFIG || {};
const currentDayKey = "concert-current-day";
const sessionKey = "concert-admin-session";

let currentDay = normalizeEventDate(localStorage.getItem(currentDayKey)) || EVENT_DATES[0];
let tickets = [];
let checkins = [];
let lineCustomers = [];
let auditLogs = [];
let currentSession = null;
let scannerStream = null;
let scannerTimer = null;
let realtimeChannel = null;
let detector = null;
let lastScanValue = "";
let lastScanAt = 0;

const elements = {
  loginView: document.querySelector("#loginView"),
  loginForm: document.querySelector("#loginForm"),
  loginUsername: document.querySelector("#loginUsername"),
  loginPassword: document.querySelector("#loginPassword"),
  loginResult: document.querySelector("#loginResult"),
  appHeader: document.querySelector("#appHeader"),
  appMain: document.querySelector("#appMain"),
  currentUserBadge: document.querySelector("#currentUserBadge"),
  logoutButton: document.querySelector("#logoutButton"),
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
  issueResult: document.querySelector("#issueResult"),
  buyerName: document.querySelector("#buyerName"),
  lineUserId: document.querySelector("#lineUserId"),
  lineCustomerList: document.querySelector("#lineCustomerList"),
  adminPin: document.querySelector("#adminPin"),
  sendLine: document.querySelector("#sendLine"),
  ticketList: document.querySelector("#ticketList"),
  checkinLog: document.querySelector("#checkinLog"),
  auditLog: document.querySelector("#auditLog"),
  manualCheckinForm: document.querySelector("#manualCheckinForm"),
  manualCode: document.querySelector("#manualCode"),
  staffName: document.querySelector("#staffName"),
  scanResult: document.querySelector("#scanResult"),
  startScanner: document.querySelector("#startScanner"),
  stopScanner: document.querySelector("#stopScanner"),
  scannerVideo: document.querySelector("#scannerVideo"),
  scannerPlaceholder: document.querySelector("#scannerPlaceholder"),
  refreshData: document.querySelector("#refreshData"),
  exportSales: document.querySelector("#exportSales"),
};

const supabaseReady = Boolean(APP_CONFIG.supabaseUrl && APP_CONFIG.supabaseAnonKey);
const db = supabaseReady
  ? window.supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey)
  : null;

document.addEventListener("DOMContentLoaded", async () => {
  wireEvents();
  syncIssueDayToCurrentDay();
  renderDayControls();
  updateQuantityState();

  if (!supabaseReady) {
    showLoginResult("ยังไม่ได้ตั้งค่า Supabase ใน config.js", "warning");
    elements.setupWarning.hidden = false;
    showResult("ยังไม่ได้ตั้งค่า Supabase ใน config.js", "warning");
    render();
    return;
  }

  restoreSession();
  if (currentSession) {
    showApp();
    await loadData();
    subscribeToChanges();
  } else {
    showLogin();
  }
});

function wireEvents() {
  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await login();
  });

  elements.logoutButton.addEventListener("click", logout);

  elements.dayButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setCurrentDay(button.dataset.currentDay);
      render();
    });
  });

  elements.issueForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await issueTicket();
  });
  elements.ticketType.addEventListener("change", updateQuantityState);
  elements.eventDay.addEventListener("change", () => {
    setCurrentDay(elements.eventDay.value, false);
    render();
  });
  elements.ticketList.addEventListener("click", handleTicketAction);

  elements.manualCheckinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await checkIn(elements.manualCode.value);
    elements.manualCode.value = "";
  });

  elements.startScanner.addEventListener("click", startScanner);
  elements.stopScanner.addEventListener("click", stopScanner);
  elements.refreshData.addEventListener("click", loadData);
  elements.exportSales.addEventListener("click", exportSalesReport);
}

function setCurrentDay(value, shouldSyncIssueDay = true) {
  currentDay = normalizeEventDate(value) || EVENT_DATES[0];
  localStorage.setItem(currentDayKey, currentDay);
  if (shouldSyncIssueDay) syncIssueDayToCurrentDay();
}

function syncIssueDayToCurrentDay() {
  if (elements.eventDay && elements.eventDay.value !== currentDay) {
    elements.eventDay.value = currentDay;
  }
}

function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(sessionKey) || "null");
    if (saved?.token && saved?.role) currentSession = saved;
  } catch {
    currentSession = null;
  }
}

async function login() {
  if (!db) return;

  const username = elements.loginUsername.value.trim();
  const password = elements.loginPassword.value;
  if (!username || !password) {
    showLoginResult("กรุณากรอก Username และ Password", "warning");
    return;
  }

  showLoginResult("กำลังเข้าสู่ระบบ", "neutral");
  const { data, error } = await db.rpc("admin_login", {
    p_username: username,
    p_password: password,
  });

  if (error) {
    showLoginResult(error.message, "error");
    return;
  }

  currentSession = data;
  localStorage.setItem(sessionKey, JSON.stringify(currentSession));
  elements.loginPassword.value = "";
  showApp();
  await loadData();
  subscribeToChanges();
}

async function logout() {
  const token = currentSession?.token;
  currentSession = null;
  localStorage.removeItem(sessionKey);
  stopScanner();
  unsubscribeFromChanges();
  showLogin();
  if (db && token) {
    db.rpc("admin_logout", { p_session_token: token }).catch(() => {});
  }
}

function showLogin() {
  elements.loginView.hidden = false;
  elements.appHeader.hidden = true;
  elements.appMain.hidden = true;
  showLoginResult("กรุณาเข้าสู่ระบบก่อนใช้งาน", "neutral");
}

function showApp() {
  elements.loginView.hidden = true;
  elements.appHeader.hidden = false;
  elements.appMain.hidden = false;
  elements.currentUserBadge.textContent = `${currentSession.display_name || currentSession.username} · ${formatRole(currentSession.role)}`;
  applyRoleUi();
}

function applyRoleUi() {
  const canIssueTickets = hasRolePermission("issue");
  const canCheckInTickets = hasRolePermission("checkin");
  const canExportSales = hasRolePermission("export");

  document.querySelector(".issue-panel").hidden = !canIssueTickets;
  document.querySelector(".scanner-panel").hidden = !canCheckInTickets;
  elements.exportSales.hidden = !canExportSales;
}

function hasRolePermission(permission) {
  if (!currentSession) return false;
  if (currentSession.role === "admin") return true;
  if (permission === "issue") return currentSession.role === "issuer";
  if (permission === "manage_ticket") return currentSession.role === "issuer";
  if (permission === "export") return currentSession.role === "issuer";
  if (permission === "checkin") return currentSession.role === "checkin";
  return false;
}

async function loadData() {
  if (!db || !currentSession) return;
  showResult("กำลังโหลดข้อมูลจากฐานข้อมูลกลาง", "neutral");

  const [ticketResult, checkinResult, auditResult] = await Promise.all([
    db
      .from("tickets")
      .select("id,ticket_type,event_day,buyer_name,line_user_id,price,capacity,perks,issued_at,canceled_at,canceled_by,cancel_reason,ticket_codes(code,seat_no,checked_in_at,staff_name)")
      .order("issued_at", { ascending: false }),
    db
      .from("checkins")
      .select("code,ticket_id,ticket_type,event_day,staff_name,checked_in_at")
      .order("checked_in_at", { ascending: false })
      .limit(200),
    db
      .from("ticket_audit_logs")
      .select("ticket_id,action,actor_username,actor_role,details,created_at")
      .order("created_at", { ascending: false })
      .limit(100),
    loadLineCustomers(),
  ]);

  if (ticketResult.error || checkinResult.error || auditResult.error) {
    showResult(ticketResult.error?.message || checkinResult.error?.message || auditResult.error?.message || "โหลดข้อมูลไม่สำเร็จ", "error");
    return;
  }

  tickets = ticketResult.data || [];
  checkins = checkinResult.data || [];
  auditLogs = auditResult.data || [];
  render();
  showResult("พร้อมใช้งาน", "neutral");
}

async function loadLineCustomers() {
  if (!hasRolePermission("issue")) {
    lineCustomers = [];
    return;
  }

  const { data, error } = await db
    .from("line_customers")
    .select("line_user_id,display_name,last_seen_at")
    .order("last_seen_at", { ascending: false })
    .limit(300);

  if (!error) lineCustomers = data || [];
}

function subscribeToChanges() {
  if (realtimeChannel) return;

  realtimeChannel = db.channel("concert-ticket-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, loadData)
    .on("postgres_changes", { event: "*", schema: "public", table: "ticket_codes" }, loadData)
    .on("postgres_changes", { event: "*", schema: "public", table: "checkins" }, loadData)
    .on("postgres_changes", { event: "*", schema: "public", table: "ticket_audit_logs" }, loadData)
    .on("postgres_changes", { event: "*", schema: "public", table: "line_customers" }, loadData)
    .subscribe();
}

function unsubscribeFromChanges() {
  if (!realtimeChannel || !db) return;
  db.removeChannel(realtimeChannel);
  realtimeChannel = null;
}

async function issueTicket() {
  if (!db) {
    showIssueResult("ยังไม่ได้เชื่อมต่อ Supabase", "error");
    return;
  }

  if (!hasRolePermission("issue")) {
    showIssueResult("บัญชีนี้ไม่มีสิทธิ์ออกบัตร", "error");
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
    showIssueResult("กรุณากรอกรหัสแอดมินก่อนออกบัตรและส่ง LINE OA", "warning");
    elements.adminPin.focus();
    return;
  }

  showIssueResult(`กำลังสร้างบัตร ${quantity} ใบ`, "neutral");
  for (let index = 0; index < quantity; index += 1) {
    const numberedName = quantity > 1 ? `${buyerName} #${index + 1}` : buyerName;
    const { data, error } = await db.rpc("issue_ticket", {
      p_ticket_type: ticketType,
      p_event_day: eventDay,
      p_buyer_name: numberedName,
      p_line_user_id: lineUserId || null,
      p_ticket_price: ticketPrice,
      p_session_token: currentSession.token,
    });

    if (error) {
      showIssueResult(error.message, "error");
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
    showIssueResult(`สร้างบัตร ${ticketIds} แล้ว`, "success");
  }

  elements.buyerName.value = "";
  elements.lineUserId.value = "";
}

async function sendTicketToLine(lineUserId, ticket) {
  const adminPin = elements.adminPin.value.trim();
  if (!adminPin) {
    showIssueResult("ไม่ได้ส่ง LINE เพราะไม่ได้กรอกรหัสแอดมิน", "warning");
    return;
  }

  showIssueResult("กำลังส่ง QR ทาง LINE OA", "neutral");
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
    showIssueResult(result.error || "ส่ง LINE ไม่สำเร็จ", "error");
    return;
  }

  showIssueResult(`สร้างบัตร ${ticket.ticket_id} และส่ง QR ทาง LINE แล้ว`, "success");
}

async function checkIn(rawCode) {
  if (!hasRolePermission("checkin")) {
    showResult("บัญชีนี้ไม่มีสิทธิ์เช็คอิน", "error");
    return;
  }

  const code = normalizeScannedValue(rawCode);
  if (!code) {
    showResult("กรุณากรอกรหัส QR", "warning");
    return;
  }

  const staffName = elements.staffName.value.trim();
  if (!staffName) {
    showResult("กรุณากรอกชื่อเจ้าหน้าที่ก่อนเช็คอิน", "warning");
    elements.staffName.focus();
    return;
  }

  const today = getBangkokDateKey();
  if (currentDay !== today) {
    showResult(`วันนี้คือ ${formatEventDate(today)} ยังไม่สามารถเช็คอินบัตรวันที่ ${formatEventDate(currentDay)} ได้`, "error");
    return;
  }

  const { data, error } = await db.rpc("check_in_ticket", {
    p_code: code,
    p_current_day: currentDay,
    p_staff_name: staffName,
    p_session_token: currentSession.token,
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

  if (data.status === "not_event_day") {
    showResult(`วันนี้คือ ${formatEventDate(data.today)} ยังไม่สามารถเช็คอินบัตรวันที่ ${formatEventDate(data.event_day)} ได้`, "error");
    return;
  }

  if (data.status === "canceled") {
    showResult(`บัตรนี้ถูกยกเลิกแล้ว: ${data.cancel_reason || "-"}`, "error");
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
  renderAuditLog();
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
    const isCanceled = Boolean(ticket.canceled_at);
    const card = document.createElement("article");
    card.className = `ticket-card ${isCanceled ? "canceled" : ""}`;
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
        ${isCanceled ? `<p><strong>ยกเลิกแล้ว</strong>: ${escapeHtml(ticket.cancel_reason || "-")} (${escapeHtml(ticket.canceled_by || "-")})</p>` : ""}
        ${ticket.perks ? `<p>สิทธิ์: ${ticket.perks}</p>` : ""}
        <div class="code-list">
          ${codes.map((qr) => `<span class="code-pill ${isCanceled ? "canceled" : qr.checked_in_at ? "used" : ""}">${qr.code}</span>`).join("")}
        </div>
        <div class="ticket-actions">
          <button class="ghost-button" type="button" data-action="copy" data-ticket-id="${ticket.id}">คัดลอกรหัส QR</button>
          <button class="ghost-button" type="button" data-action="download" data-ticket-id="${ticket.id}">ดาวน์โหลด QR</button>
          <button class="ghost-button" type="button" data-action="print" data-ticket-id="${ticket.id}">พิมพ์บัตร</button>
          <button class="primary-button" type="button" data-action="open" data-ticket-id="${ticket.id}">เปิดหน้าลูกค้า</button>
          ${hasRolePermission("manage_ticket") && ticket.ticket_type === "Regular" && !isCanceled ? `<button class="ghost-button" type="button" data-action="edit-price" data-ticket-id="${ticket.id}">แก้ราคา</button>` : ""}
          ${hasRolePermission("manage_ticket") && !isCanceled ? `<button class="danger-button" type="button" data-action="cancel" data-ticket-id="${ticket.id}">ยกเลิกบัตร</button>` : ""}
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

function renderAuditLog() {
  if (!auditLogs.length) {
    elements.auditLog.innerHTML = `<tr><td colspan="5">ยังไม่มีประวัติการแก้ไข</td></tr>`;
    return;
  }

  elements.auditLog.innerHTML = auditLogs
    .map((item) => `
      <tr>
        <td>${new Date(item.created_at).toLocaleString("th-TH")}</td>
        <td>${escapeHtml(item.actor_username)} (${formatRole(item.actor_role)})</td>
        <td>${escapeHtml(item.ticket_id || "-")}</td>
        <td>${formatAuditAction(item.action)}</td>
        <td>${escapeHtml(formatAuditDetails(item))}</td>
      </tr>
    `)
    .join("");
}

function exportSalesReport() {
  if (!hasRolePermission("export")) {
    showResult("บัญชีนี้ไม่มีสิทธิ์ Export รายงาน", "error");
    return;
  }

  const rows = [
    ["ticket_id", "ticket_type", "event_day", "buyer_name", "price", "capacity", "status", "issued_at", "canceled_at", "cancel_reason"],
    ...tickets.map((ticket) => [
      ticket.id,
      ticket.ticket_type,
      ticket.event_day,
      ticket.buyer_name || "",
      ticket.price,
      ticket.capacity,
      ticket.canceled_at ? "canceled" : "active",
      ticket.issued_at,
      ticket.canceled_at || "",
      ticket.cancel_reason || "",
    ]),
    [],
    ["summary"],
    ["active_revenue", tickets.filter((ticket) => !ticket.canceled_at).reduce((sum, ticket) => sum + Number(ticket.price || 0), 0)],
    ["active_tickets", tickets.filter((ticket) => !ticket.canceled_at).length],
    ["canceled_tickets", tickets.filter((ticket) => ticket.canceled_at).length],
  ];

  downloadCsv(`sales-report-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  showResult("ดาวน์โหลดรายงานยอดขายแล้ว", "success");
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
  } else if (button.dataset.action === "edit-price") {
    await editTicketPrice(ticket);
  } else if (button.dataset.action === "cancel") {
    await cancelTicket(ticket);
  }
}

async function editTicketPrice(ticket) {
  if (!hasRolePermission("manage_ticket")) {
    showResult("บัญชีนี้ไม่มีสิทธิ์แก้ไขบัตร", "error");
    return;
  }

  const value = window.prompt(`แก้ราคา ${ticket.id} เป็น 150 หรือ 180`, String(ticket.price));
  if (value === null) return;

  const newPrice = Number.parseInt(value, 10);
  if (![150, 180].includes(newPrice)) {
    showResult("ราคา Regular ต้องเป็น 150 หรือ 180", "warning");
    return;
  }

  const { error } = await db.rpc("update_ticket_price", {
    p_ticket_id: ticket.id,
    p_ticket_price: newPrice,
    p_session_token: currentSession.token,
  });

  if (error) {
    showResult(error.message, "error");
    return;
  }

  await loadData();
  showResult(`แก้ราคา ${ticket.id} เป็น ${newPrice.toLocaleString("th-TH")} บาทแล้ว`, "success");
}

async function cancelTicket(ticket) {
  if (!hasRolePermission("manage_ticket")) {
    showResult("บัญชีนี้ไม่มีสิทธิ์ยกเลิกบัตร", "error");
    return;
  }

  const reason = window.prompt(`เหตุผลที่ยกเลิก ${ticket.id}`, "ออกบัตรผิด");
  if (reason === null) return;

  const confirmed = window.confirm(`ยืนยันยกเลิกบัตร ${ticket.id}? QR ของบัตรนี้จะเช็คอินไม่ได้`);
  if (!confirmed) return;

  const { error } = await db.rpc("cancel_ticket", {
    p_ticket_id: ticket.id,
    p_reason: reason,
    p_session_token: currentSession.token,
  });

  if (error) {
    showResult(error.message, "error");
    return;
  }

  await loadData();
  showResult(`ยกเลิกบัตร ${ticket.id} แล้ว`, "success");
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

function formatRole(role) {
  const labels = {
    admin: "แอดมิน",
    issuer: "ออกบัตร",
    checkin: "เช็คอิน",
  };
  return labels[role] || role || "-";
}

function formatAuditAction(action) {
  const labels = {
    issue: "ออกบัตร",
    update_price: "แก้ราคา",
    cancel: "ยกเลิกบัตร",
    checkin: "เช็คอิน",
  };
  return labels[action] || action || "-";
}

function formatAuditDetails(item) {
  const details = item.details || {};
  if (item.action === "update_price") return `${details.old_price} -> ${details.new_price} บาท`;
  if (item.action === "cancel") return details.reason || "-";
  if (item.action === "issue") return `${details.ticket_type || "-"} ${details.price || "-"} บาท ${details.event_day || ""}`.trim();
  if (item.action === "checkin") return `${details.code || "-"} โดย ${details.staff_name || "-"}`;
  return JSON.stringify(details);
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(link.href);
  link.remove();
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function normalizeScannedValue(value) {
  return String(value || "").trim().toUpperCase();
}

function showResult(message, type) {
  elements.scanResult.textContent = message;
  elements.scanResult.className = `scan-result ${type}`;
}

function showIssueResult(message, type) {
  elements.issueResult.textContent = message;
  elements.issueResult.className = `scan-result ${type}`;
}

function showLoginResult(message, type) {
  elements.loginResult.textContent = message;
  elements.loginResult.className = `scan-result ${type}`;
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
    timeZone: "Asia/Bangkok",
  }).format(new Date(`${normalized}T00:00:00+07:00`));
}

function getBangkokDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
