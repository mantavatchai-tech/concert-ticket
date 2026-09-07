const TICKET_COLORS=['#0f766e','#1d4ed8','#7c3aed','#b91c1c','#c2410c','#15803d','#111827'];
let eventSettings = [];
let backedUpEventDay = null;
let metrics = { daily: [] };
let ticketPage = 0, checkinPage = 0, ticketCount = 0;
let issuing = false, loading = false;
let users = [];
let EVENT_DATES = [];
const APP_CONFIG = window.APP_CONFIG || {};
const currentDayKey = "concert-current-day";
const sessionKey = "concert-admin-session";

let currentDay = normalizeEventDate(localStorage.getItem(currentDayKey)) || "";
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
let pendingScanValue = "";

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
  regularSold: document.querySelector("#regularSold"),
  regularDailyBreakdown: document.querySelector("#regularDailyBreakdown"),
  totalCanceled: document.querySelector("#totalCanceled"),
  vipRemaining: document.querySelector("#vipRemaining"),
  vipDailyBreakdown: document.querySelector("#vipDailyBreakdown"),
  issueForm: document.querySelector("#issueForm"),
  ticketType: document.querySelector("#ticketType"),
  ticketPrice: document.querySelector("#ticketPrice"),
  ticketQuantity: document.querySelector("#ticketQuantity"),
  eventDay: document.querySelector("#eventDay"),
  issueResult: document.querySelector("#issueResult"),
  buyerName: document.querySelector("#buyerName"),
  lineUserId: document.querySelector("#lineUserId"),
  lineCustomerList: document.querySelector("#lineCustomerList"),
  sendLine: document.querySelector("#sendLine"),
  ticketList: document.querySelector("#ticketList"),
  checkinLog: document.querySelector("#checkinLog"),
  auditPanel: document.querySelector(".audit-panel"),
  auditLog: document.querySelector("#auditLog"),
  manualCheckinForm: document.querySelector("#manualCheckinForm"),
  manualCode: document.querySelector("#manualCode"),
  staffName: document.querySelector("#staffName"),
  scanResult: document.querySelector("#scanResult"),
  startScanner: document.querySelector("#startScanner"),
  stopScanner: document.querySelector("#stopScanner"),
  scanConfirmBox: document.querySelector("#scanConfirmBox"),
  pendingScanCode: document.querySelector("#pendingScanCode"),
  confirmScan: document.querySelector("#confirmScan"),
  cancelScan: document.querySelector("#cancelScan"),
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
  updateLineInputState();

  if (!supabaseReady) {
    showLoginResult("ยังไม่ได้ตั้งค่า Supabase ใน config.js", "warning");
    elements.setupWarning.hidden = false;
    showResult("ยังไม่ได้ตั้งค่า Supabase ใน config.js", "warning");
    render();
    return;
  }

  localStorage.removeItem(sessionKey);
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

  document.querySelector('.event-day-switch').addEventListener('click', async event => {
    const button = event.target.closest('[data-current-day]');
    if (!button) return;
    setCurrentDay(button.dataset.currentDay); ticketPage=0; checkinPage=0;
    await loadData();
  });

  elements.issueForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await issueTicket();
  });
  elements.ticketType.addEventListener("change", updateQuantityState);
  elements.sendLine.addEventListener("change", updateLineInputState);
  elements.eventDay.addEventListener("change", () => {
    setCurrentDay(elements.eventDay.value, false);
    ticketPage=0; checkinPage=0; loadData();
  });
  elements.ticketList.addEventListener("click", handleTicketAction);

  elements.manualCheckinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await checkIn(elements.manualCode.value);
    elements.manualCode.value = "";
  });

  elements.startScanner.addEventListener("click", startScanner);
  elements.stopScanner.addEventListener("click", stopScanner);
  elements.confirmScan.addEventListener("click", confirmPendingScan);
  elements.cancelScan.addEventListener("click", cancelPendingScan);
  elements.refreshData.addEventListener("click", loadData);
  elements.exportSales.addEventListener("click", exportSalesReport);
}

function setCurrentDay(value, shouldSyncIssueDay = true) {
  currentDay = normalizeEventDate(value) || "";
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
    const saved = JSON.parse(sessionStorage.getItem(sessionKey) || "null");
    if (saved?.token && saved?.role && new Date(saved.expires_at).getTime() > Date.now()) currentSession = saved;
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

  if (error || data?.error || !data?.token) {
    showLoginResult(error?.message || data?.error || "เข้าสู่ระบบไม่สำเร็จ", "error");
    return;
  }

  currentSession = data;
  sessionStorage.setItem(sessionKey, JSON.stringify(currentSession));
  elements.loginPassword.value = "";
  showApp();
  await loadData();
  subscribeToChanges();
}

async function logout() {
  const token = currentSession?.token;
  currentSession = null;
  tickets = []; checkins = []; lineCustomers = []; auditLogs = []; users = [];
  elements.ticketList.replaceChildren(); elements.checkinLog.replaceChildren(); elements.auditLog.replaceChildren();
  document.querySelector("#userList").replaceChildren();
  elements.lineCustomerList.replaceChildren();
  elements.issueForm.reset(); document.querySelector("#paymentForm").reset();
  sessionStorage.removeItem(sessionKey);
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
  const canViewAuditLog = currentSession?.role === "admin";

  document.querySelector(".issue-panel").hidden = !canIssueTickets;
  document.querySelector(".scanner-panel").hidden = !canCheckInTickets;
  elements.auditPanel.hidden = !canViewAuditLog;
  elements.exportSales.hidden = !canExportSales;
  document.querySelector("#adminSettings").hidden = currentSession?.role !== "admin";
  document.querySelector("#ticketsPanel").hidden = !canIssueTickets;
  document.querySelector("#paymentMetric").hidden = !canIssueTickets;
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
  if (!db || !currentSession || loading) return;
  loading = true;
  const token = currentSession.token;
  const requestedDay = currentDay;
  try {
    const {data,error} = await db.rpc('get_dashboard', {
      p_session_token:token,p_event_day:currentDay,p_page:ticketPage,p_checkin_page:checkinPage
    });
    if(error) throw error;
    if(currentSession?.token !== token) return;
    currentSession = {...currentSession,...data.user};
    eventSettings=data.events; EVENT_DATES=eventSettings.map(e=>e.event_day);
    if(!EVENT_DATES.includes(currentDay)) {
      currentDay=EVENT_DATES.find(d=>d>=getBangkokDateKey()) || EVENT_DATES.at(-1) || '';
    }
    tickets=data.tickets; checkins=data.checkins; auditLogs=data.audit_logs;
    lineCustomers=data.line_customers; users=data.users; metrics=data.metrics; ticketCount=data.ticket_count;
    renderEventOptions(); applyRoleUi(); render(); renderSettings(); updatePaging();
    showResult('ข้อมูลอัปเดตแล้ว','success');
  } catch(error) {
    if(error.code==='28000') await logout();
    showResult(error.message || 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่','error');
  } finally {
    loading=false;
    if(currentSession?.token===token && currentDay!==requestedDay) await loadData();
  }
}

function renderEventOptions() {
  const selected=elements.eventDay.value;
  elements.eventDay.innerHTML=eventSettings.map(e=>`<option value="${e.event_day}">${escapeHtml(e.name)} · ${formatEventDate(e.event_day)}${e.active?'':' (ปิดขาย)'}</option>`).join('');
  elements.eventDay.value=currentDay;
  document.querySelector('.event-day-switch').innerHTML=eventSettings.map(e=>`<button type="button" class="day-chip" data-current-day="${e.event_day}" style="--event-color:${safeTicketColor(e.ticket_color)}">${formatShortEventDate(e.event_day)}</button>`).join('');
  elements.dayButtons=document.querySelectorAll('[data-current-day]');
  const setting=eventSettings.find(e=>e.event_day===currentDay);
  const previous=elements.ticketPrice.value;
  elements.ticketPrice.innerHTML=(setting?.regular_prices || []).map(p=>`<option value="${p}">${p} บาท</option>`).join('');
  if(selected===currentDay && setting?.regular_prices.map(String).includes(previous)) elements.ticketPrice.value=previous;
  elements.ticketType.options[0].textContent=`VIP · ${setting?.vip_price ?? '-'} บาท / 4 คน`;
  elements.ticketType.options[1].textContent='Regular · 1 คน';
  updateQuantityState();
}

function subscribeToChanges() {
  if(realtimeChannel) return;
  // Direct table subscriptions are intentionally closed by database permissions.
  realtimeChannel=window.setInterval(()=>{if(!document.hidden) loadData();},15000);
}
function unsubscribeFromChanges() {
  window.clearInterval(realtimeChannel); realtimeChannel=null;
}

async function issueTicket() {
  if(issuing || !db || !hasRolePermission('issue')) return;
  const wantsLine=elements.sendLine.checked;
  const payload={p_ticket_type:elements.ticketType.value,p_event_day:elements.eventDay.value,
    p_buyer_name:elements.buyerName.value.trim() || '-',p_line_user_id:wantsLine ? (elements.lineUserId.value.trim() || null) : null,
    p_ticket_price:elements.ticketType.value==='Regular'?clampRegularPrice(elements.ticketPrice.value):null,
    p_quantity:elements.ticketType.value==='Regular'?clampQuantity(elements.ticketQuantity.value):1};
  if(wantsLine && !payload.p_line_user_id) {showIssueResult('กรอก LINE userId หรือยกเลิกการส่ง LINE','warning'); return;}
  const key='pending-issue-'+currentSession.username;
  let pending;
  try {pending=JSON.parse(localStorage.getItem(key) || 'null');} catch {pending=null;}
  if(pending && JSON.stringify(pending.payload)!==JSON.stringify(payload)) {
    showIssueResult('มีรายการก่อนหน้ารอยืนยัน กด “กู้คืนรายการค้าง” เพื่อตรวจผลก่อนสร้างรายการใหม่','warning');return;
  }
  if(!pending) pending={id:crypto.randomUUID(),payload,wantsLine};
  // Persist before sending; a retry always reuses the same request id and payload.
  try {localStorage.setItem(key,JSON.stringify(pending));}
  catch {showIssueResult('ไม่สามารถบันทึกรายการค้างในเครื่อง กรุณาเปิดพื้นที่เก็บข้อมูลของเบราว์เซอร์','error');return;}
  await submitIssue(pending,key);
}

async function submitIssue(pending,key) {
  if(issuing) return;
  issuing=true;
  const button=elements.issueForm.querySelector('[type=submit]'); button.disabled=true;
  let created=false;
  try {
    const {data,error}=await db.rpc('issue_ticket_batch',{
      ...pending.payload,p_session_token:currentSession.token,p_request_id:pending.id
    });
    if(error) {
      // Explicit SQL validation failures roll back the whole batch. Network failures remain pending.
      if(error.code==='P0001' || /^23/.test(error.code || '')) localStorage.removeItem(key);
      throw error;
    }
    created=true; localStorage.removeItem(key);
    elements.buyerName.value=''; elements.lineUserId.value='';
    const failed=[];
    if(pending.wantsLine) for(const t of data) {
      try {await sendTicketToLine(t);} catch {failed.push(t.ticket_id);}
    }
    ticketPage=0; await loadData();
    showIssueResult(`สร้างครบ ${data.length} ใบ: ${data.map(t=>t.ticket_id).join(', ')}${failed.length?' · ส่ง LINE ไม่สำเร็จ: '+failed.join(', ')+' ใช้ปุ่มส่งซ้ำที่รายการบัตร':''}`,failed.length?'warning':'success');
  } catch(error) {
    const rejected=error.code==='P0001' || /^23/.test(error.code || '');
    showIssueResult((created?'สร้างบัตรแล้ว แต่ขั้นตอนต่อไปไม่สำเร็จ: ':rejected?'ไม่มีบัตรถูกสร้าง: ':'ยังยืนยันผลไม่ได้ ใช้กู้คืนรายการค้างเพื่อตรวจผล: ')+(error.message || 'การเชื่อมต่อขัดข้อง'),'error');
  } finally { issuing=false;button.disabled=false; }
}

async function sendTicketToLine(ticket) {
  const response=await fetch('/api/send-line-ticket',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+currentSession.token},
    body:JSON.stringify({ticketId:ticket.ticket_id || ticket.id})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(result.error || 'ส่ง LINE ไม่สำเร็จ');
}

function updatePaging() {
  document.querySelector('#ticketPageLabel').textContent=`หน้า ${ticketPage+1} · ${ticketCount} ใบ`;
  document.querySelector('#ticketPrev').disabled=ticketPage===0;
  document.querySelector('#ticketNext').disabled=(ticketPage+1)*50>=ticketCount;
  document.querySelector('#checkinPageLabel').textContent=`หน้า ${checkinPage+1} · ${metrics.today_checkins || 0} รายการ`;
  document.querySelector('#checkinPrev').disabled=checkinPage===0;
  document.querySelector('#checkinNext').disabled=(checkinPage+1)*50>=(metrics.today_checkins || 0);
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
    resumeScanner();
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
  clearPendingScan();
  elements.scannerVideo.srcObject = null;
  elements.scannerPlaceholder.style.display = "grid";
}

async function scanFrame() {
  if (!detector || pendingScanValue || !elements.scannerVideo.videoWidth) return;

  try {
    const codes = await detector.detect(elements.scannerVideo);
    if (!codes.length) return;

    const value = codes[0].rawValue;
    const now = Date.now();
    if (value === lastScanValue && now - lastScanAt < 2500) return;

    lastScanValue = value;
    lastScanAt = now;
    pendingScanValue = value;
    if (scannerTimer) window.clearInterval(scannerTimer);
    scannerTimer = null;
    elements.pendingScanCode.textContent = normalizeScannedValue(value) || value;
    elements.scanConfirmBox.hidden = false;
    showResult("พบ QR แล้ว กรุณากดยืนยันก่อนเช็คอิน", "warning");
  } catch {
    showResult("อ่าน QR ไม่สำเร็จ ลองขยับกล้องหรือกรอกรหัสแทน", "warning");
  }
}

async function confirmPendingScan() {
  if (!pendingScanValue) return;
  const value = pendingScanValue;
  clearPendingScan();
  await checkIn(value);
  resumeScanner();
}

function cancelPendingScan() {
  clearPendingScan();
  showResult("ยกเลิก QR ที่อ่านได้แล้ว พร้อมสแกนใหม่", "neutral");
  resumeScanner();
}

function clearPendingScan() {
  pendingScanValue = "";
  elements.pendingScanCode.textContent = "-";
  elements.scanConfirmBox.hidden = true;
}

function resumeScanner() {
  if (!scannerStream || scannerTimer) return;
  scannerTimer = window.setInterval(scanFrame, 650);
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
  const daily = metrics.daily || [];
  const today = daily.find(d => d.event_day === currentDay);
  elements.todayCheckins.textContent = metrics.today_checkins || 0;
  elements.totalCheckins.textContent = metrics.total_checkins || 0;
  elements.totalIssued.textContent = metrics.total_codes || 0;
  elements.regularSold.textContent = metrics.regular_sold || 0;
  elements.totalCanceled.textContent = metrics.canceled || 0;
  elements.vipRemaining.textContent = today ? Math.max(0,today.vip_limit-today.vip_sold) : 0;
  elements.regularDailyBreakdown.innerHTML = '';
  elements.vipDailyBreakdown.innerHTML = '';
  document.querySelector('#receivedAmount').textContent = Number(metrics.received || 0).toLocaleString('th-TH');
}

function renderLineCustomers() {
  elements.lineCustomerList.innerHTML = lineCustomers
    .map((customer) => {
      const label = customer.display_name ? `${customer.display_name} - ${customer.line_user_id}` : customer.line_user_id;
      return `<option value="${escapeHtml(customer.line_user_id)}" label="${escapeHtml(label)}">${escapeHtml(label)}</option>`;
    })
    .join("");
}

function renderTickets() {
  const dayTickets = tickets.filter((ticket) => ticket.event_day === currentDay);

  if (!dayTickets.length) {
    elements.ticketList.innerHTML = `<p class="empty-state">ยังไม่มีบัตรที่ออกสำหรับ ${formatEventDate(currentDay)}</p>`;
    return;
  }

  elements.ticketList.innerHTML = "";
  dayTickets.forEach((ticket) => {
    const codes = getSortedCodes(ticket);
    const isCanceled = Boolean(ticket.canceled_at);
    const card = document.createElement("article");
    card.className = `ticket-card ${isCanceled ? "canceled" : ""}`;
    const eventColor=safeTicketColor(eventSettings.find(e=>e.event_day===ticket.event_day)?.ticket_color);
    card.style.setProperty("--event-color",eventColor);
    card.innerHTML = `
      <div class="ticket-qr-grid">
        ${codes.map((qr) => `
          <div class="ticket-qr-item">
            <div class="qr-box" data-qr="${qr.code}" data-qr-color="${eventColor}" aria-label="QR ${qr.code}"></div>
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
        ${ticket.perks ? `<p>สิทธิ์: ${escapeHtml(ticket.perks)}</p>` : ""}
        <div class="code-list">
          ${codes.map((qr) => `<span class="code-pill ${isCanceled ? "canceled" : qr.checked_in_at ? "used" : ""}">${qr.code}</span>`).join("")}
        </div>
        <p>ชำระเงิน: ${escapeHtml(paymentLabel(ticket.payment_status))} · รับสุทธิ ${ticket.paid_amount || 0} บาท</p>
        <p>ส่ง LINE: ${escapeHtml(ticket.line_status || 'ยังไม่ส่ง')}</p>
        <div class="ticket-actions">
          ${hasRolePermission('manage_ticket') ? '<button type="button" class="ghost-button" data-action="payment" data-ticket-id="'+ticket.id+'">บันทึกชำระ / คืนเงิน</button>' : ''}
          ${hasRolePermission('issue') && ticket.line_user_id && !isCanceled ? '<button type="button" class="ghost-button" data-action="send-line" data-ticket-id="'+ticket.id+'">ส่ง / ลองส่ง LINE อีกครั้ง</button>' : ''}
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
    const color=safeTicketColor(box.dataset.qrColor);
    box.innerHTML = "";
    if (window.QRCode) {
      new QRCode(box, { text: code, width: 58, height: 58, colorDark: color, colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
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
  if (currentSession?.role !== "admin") {
    elements.auditLog.innerHTML = "";
    return;
  }

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

async function exportSalesReport() {
  if (!hasRolePermission('export')) return;
  const button=elements.exportSales; button.disabled=true;
  try {
    const all=[]; const asOf=new Date().toISOString();
    for(let page=0;;page++) {
      const {data,error}=await db.rpc('get_sales_report',{p_session_token:currentSession.token,p_page:page,p_as_of:asOf});
      if(error) throw error;
      all.push(...data); if(data.length<500) break;
    }
    const columns=['id','ticket_type','event_day','buyer_name','price','capacity','issued_at','canceled_at','payment_status','payment_reference','paid_amount','payment_confirmed_by','payment_confirmed_at'];
    const rows=[columns,...all.map(t=>columns.map(c=>t[c] ?? '')),[],['ยอดรับเงินจริงสุทธิ',all.filter(t=>t.payment_status==='paid').reduce((s,t)=>s+t.paid_amount,0)],['มูลค่าบัตรที่ยังไม่ยกเลิก',all.filter(t=>!t.canceled_at).reduce((s,t)=>s+t.price,0)]];
    downloadCsv('sales-report-'+asOf.slice(0,10)+'.csv',rows);
    showResult('ดาวน์โหลดรายงานครบ '+all.length+' ใบแล้ว','success');
  } catch(error) { showResult(error.message,'error'); } finally {button.disabled=false;}
}

async function handleTicketAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const ticket = tickets.find((item) => item.id === button.dataset.ticketId);
  if (!ticket) return;

  if (button.dataset.action === 'payment') {
    openPayment(ticket);
  } else if (button.dataset.action === 'send-line') {
    button.disabled=true;
    try { await sendTicketToLine(ticket); await loadData(); showResult('LINE รับคำขอส่งบัตรแล้ว','success'); }
    catch(error) { showResult(error.message,'error'); }
    finally {button.disabled=false;}
  } else if (button.dataset.action === "copy") {
    await copyTicketCodes(ticket);
  } else if (button.dataset.action === "download") {
    downloadTicketQrs(ticket);
  } else if (button.dataset.action === "print") {
    printTicket(ticket);
  } else if (button.dataset.action === "open") {
    window.open(getTicketUrl(ticket), "_blank", "noopener");
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

  const prices = eventSettings.find(e => e.event_day===ticket.event_day)?.regular_prices || [];
  const value = window.prompt(`แก้ราคา ${ticket.id} เป็น ${prices.join(" / ")}`, String(ticket.price));
  if (value === null) return;

  const newPrice = Number(value);
  if (!prices.includes(newPrice)) {
    showResult("ราคาไม่อยู่ในรายการราคาของงาน", "warning");
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

function printTicket(ticket) { window.open(getTicketUrl(ticket)+'&print=1','_blank','noopener'); }

function getSortedCodes(ticket) {
  return [...ticket.ticket_codes].sort((a, b) => a.seat_no - b.seat_no);
}

function getTicketUrl(ticket) {
  return `${window.location.origin}/ticket.html#token=${encodeURIComponent(ticket.access_token)}`;
}

function updateLineInputState() {
  const enabled=elements.sendLine.checked;
  elements.lineUserId.disabled=!enabled;
  elements.lineUserId.required=enabled;
  if(!enabled) elements.lineUserId.value="";
}

function updateQuantityState() {
  const isRegular = elements.ticketType.value === "Regular";
  elements.ticketPrice.disabled = !isRegular;
  elements.ticketQuantity.disabled = !isRegular;
  if(!elements.ticketPrice.value && elements.ticketPrice.options.length) elements.ticketPrice.selectedIndex=0;
  elements.ticketQuantity.value = isRegular ? elements.ticketQuantity.value || "1" : "1";
}

function clampQuantity(value) {
  const quantity = Number.parseInt(value, 10);
  if (Number.isNaN(quantity)) return 1;
  return Math.min(Math.max(quantity, 1), 50);
}

function clampRegularPrice(value) {
  const price = Number.parseInt(value, 10);
  const prices=eventSettings.find(e=>e.event_day===currentDay)?.regular_prices || [];
  return prices.includes(price) ? price : prices[0];
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
  const raw = String(value ?? "");
  const text = /^[=+@\-\t\r\n]/.test(raw) ? "'"+raw : raw;
  return `"${text.replace(/"/g, '""')}"`;
}

function normalizeScannedValue(value) {
  return String(value || "").trim().toUpperCase();
}

function excelXmlEscape(value) {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function excelColumnName(index) {
  let name=''; for(let n=index+1;n;n=Math.floor((n-1)/26)) name=String.fromCharCode(65+(n-1)%26)+name; return name;
}
function backupToXlsx(backup) {
  const sheets=[['สรุป',[{backup_version:backup.backup_version,created_at:backup.created_at,created_by:backup.created_by,...(backup.event||{})}]],['บัตร',backup.tickets||[]],['QR',backup.ticket_codes||[]],['เช็กอิน',backup.checkins||[]],['การส่ง LINE',backup.line_deliveries||[]],['ประวัติ',backup.audit_logs||[]]];
  const xmlHeader='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files={};
  const overrides=sheets.map((_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('');
  files['[Content_Types].xml']=fflate.strToU8(xmlHeader+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+overrides+'</Types>');
  files['_rels/.rels']=fflate.strToU8(xmlHeader+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  files['xl/workbook.xml']=fflate.strToU8(xmlHeader+'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+sheets.map((s,i)=>'<sheet name="'+excelXmlEscape(s[0])+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets></workbook>');
  files['xl/_rels/workbook.xml.rels']=fflate.strToU8(xmlHeader+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+'<Relationship Id="rId'+(sheets.length+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  files['xl/styles.xml']=fflate.strToU8(xmlHeader+'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>');
  sheets.forEach(([name,rows],sheetIndex)=>{const columns=[...new Set(rows.flatMap(row=>Object.keys(row||{})))];const values=[columns,...rows.map(row=>columns.map(column=>row[column]))];const rowXml=values.map((row,ri)=>'<row r="'+(ri+1)+'">'+row.map((value,ci)=>{const ref=excelColumnName(ci)+(ri+1),display=value&&typeof value==='object'?JSON.stringify(value):value;if(typeof display==='number'&&Number.isFinite(display))return '<c r="'+ref+'"'+(ri===0?' s="1"':'')+'><v>'+display+'</v></c>';if(typeof display==='boolean')return '<c r="'+ref+'" t="b"'+(ri===0?' s="1"':'')+'><v>'+(display?1:0)+'</v></c>';return '<c r="'+ref+'" t="inlineStr"'+(ri===0?' s="1"':'')+'><is><t xml:space="preserve">'+excelXmlEscape(display)+'</t></is></c>';}).join('')+'</row>').join('');const cols=columns.map((_,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="22" customWidth="1"/>').join('');files['xl/worksheets/sheet'+(sheetIndex+1)+'.xml']=fflate.strToU8(xmlHeader+'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>'+cols+'</cols><sheetData>'+rowXml+'</sheetData></worksheet>');});
  return fflate.zipSync(files,{level:6});
}

function backupToExcelXml(backup) {
  const sheets=[
    ['สรุป',[{backup_version:backup.backup_version,created_at:backup.created_at,created_by:backup.created_by,...(backup.event || {})}]],
    ['บัตร',backup.tickets || []],['QR',backup.ticket_codes || []],['เช็กอิน',backup.checkins || []],
    ['การส่ง LINE',backup.line_deliveries || []],['ประวัติ',backup.audit_logs || []]
  ];
  const worksheet=([name,rows])=>{
    const columns=[...new Set(rows.flatMap(row=>Object.keys(row || {})))];
    const cell=value=>{const display=value && typeof value==='object'?JSON.stringify(value):value;const type=typeof display==='number'?'Number':typeof display==='boolean'?'Boolean':'String';return '<Cell><Data ss:Type="'+type+'">'+excelXmlEscape(display)+'</Data></Cell>';};
    const header='<Row>'+columns.map(column=>'<Cell ss:StyleID="Header"><Data ss:Type="String">'+excelXmlEscape(column)+'</Data></Cell>').join('')+'</Row>';
    const body=rows.map(row=>'<Row>'+columns.map(column=>cell(row[column])).join('')+'</Row>').join('');
    return '<Worksheet ss:Name="'+excelXmlEscape(name.slice(0,31))+'"><Table>'+header+body+'</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane></WorksheetOptions></Worksheet>';
  };
  return '<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#DDEBF7" ss:Pattern="Solid"/></Style></Styles>'+sheets.map(worksheet).join('')+'</Workbook>';
}

let toastTimer;
function showToast(message,type='neutral') {
  const toast=document.querySelector('#appToast');
  if(!toast || !message) return;
  clearTimeout(toastTimer);toast.textContent=message;toast.className='app-toast '+type;toast.hidden=false;
  toastTimer=setTimeout(()=>{toast.hidden=true;},10000);
}
function setStatus(element,message,type='neutral') {
  if(!element) return; element.textContent=message;element.className=type;showToast(message,type);
}

function showResult(message, type) {
  elements.scanResult.textContent = message;
  elements.scanResult.className = `scan-result ${type}`;
  showToast(message,type);
}

function showIssueResult(message, type) {
  elements.issueResult.textContent = message;
  elements.issueResult.className = `scan-result ${type}`;
  showToast(message,type);
}

function showLoginResult(message, type) {
  elements.loginResult.textContent = message;
  elements.loginResult.className = `scan-result ${type}`;
  showToast(message,type);
}

function normalizeEventDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return value;
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

function formatShortEventDate(value) {
  const normalized = normalizeEventDate(value) || value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized || "-";
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
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

function paymentLabel(status) {
  return {unverified:'ข้อมูลเดิมยังไม่ตรวจสอบ',pending:'รอชำระ',paid:'ชำระแล้ว',refunded:'คืนเงินแล้ว'}[status] || status;
}
function openPayment(ticket) {
  const form=document.querySelector('#paymentForm');
  form.elements.ticketId.value=ticket.id;
  form.elements.status.value=ticket.payment_status==='unverified'?'pending':ticket.payment_status;
  form.elements.reference.value=ticket.payment_reference || '';
  form.elements.amount.value=ticket.payment_status==='paid'?ticket.paid_amount:0;
  document.querySelector('#paymentDialog').showModal();
}
function renderSettings() {
  document.querySelector('#userList').textContent=users.map(u=>`${u.username} · ${formatRole(u.role)} · ${u.active?'เปิดใช้งาน':'ปิดใช้งาน'}`).join('\n');
  document.querySelector('#eventList').textContent=eventSettings.map(e=>`${e.event_day} · สี ${e.ticket_color || '#0f766e'} · ${e.name} · VIP ${e.vip_price} บาท (${e.vip_limit} ใบ) · Regular ${e.regular_prices.join('/')} บาท (${e.regular_limit} ใบ) · ${e.active?'เปิดขาย':'ปิดขาย'}`).join('\n');
}
document.addEventListener('DOMContentLoaded',()=>{
  for(const [id,kind,delta] of [['ticketPrev','ticket',-1],['ticketNext','ticket',1],['checkinPrev','checkin',-1],['checkinNext','checkin',1]]) {
    document.querySelector('#'+id).addEventListener('click',async()=>{
      if(loading) return;
      if(kind==='ticket') ticketPage=Math.max(0,ticketPage+delta); else checkinPage=Math.max(0,checkinPage+delta);
      await loadData();
    });
  }
  document.querySelector('#recoverIssue').addEventListener('click',async()=>{
    if(!currentSession || issuing) return;
    const key='pending-issue-'+currentSession.username;
    let pending; try {pending=JSON.parse(localStorage.getItem(key) || 'null');} catch {pending=null;}
    if(!pending) {showIssueResult('ไม่มีรายการค้าง','neutral');return;}
    await submitIssue(pending,key);
  });
  const bind=(id,fn)=>document.querySelector('#'+id).addEventListener('submit',async event=>{
    event.preventDefault(); const form=event.currentTarget;const button=form.querySelector('[type=submit]');
    const result=form.querySelector('[role=status]');button.disabled=true;
    try {await fn(form); setStatus(result,'บันทึกสำเร็จ','success');await loadData();}
    catch(error) {setStatus(result,error.message || 'การเชื่อมต่อขัดข้อง','error');}
    finally {button.disabled=false;}
  });
  const rpc=async(name,args)=>{const {data,error}=await db.rpc(name,{p_session_token:currentSession.token,...args});if(error) throw error;return data;};
  bind('passwordForm',async f=>{
    await rpc('change_password',{p_old_password:f.elements.oldPassword.value,p_new_password:f.elements.newPassword.value});
    f.reset();await logout();showLoginResult('เปลี่ยนรหัสผ่านแล้ว กรุณาเข้าสู่ระบบใหม่','success');
  });
  bind('userForm',async f=>{
    await rpc('manage_user',{p_username:f.elements.username.value,p_display_name:f.elements.displayName.value,p_role:f.elements.role.value,p_active:f.elements.active.checked,p_password:f.elements.password.value || null});
    f.elements.password.value='';
  });
  document.querySelector('#revokeSessions').addEventListener('click',async()=>{
    const f=document.querySelector('#userForm');
    try {await rpc('revoke_user_sessions',{p_username:f.elements.username.value});setStatus(f.querySelector('[role=status]'),'ยกเลิก session แล้ว','success');}
    catch(e) {setStatus(f.querySelector('[role=status]'),e.message,'error');}
  });
  bind('eventForm',async f=>{
    await rpc('save_event',{p_event_day:f.elements.day.value,p_name:f.elements.eventName.value,p_active:f.elements.active.checked,
      p_vip_limit:Number(f.elements.vipLimit.value),p_regular_limit:Number(f.elements.regularLimit.value),p_vip_price:Number(f.elements.vipPrice.value),
      p_regular_prices:f.elements.regularPrices.value.split(',').map(v=>Number(v.trim())),p_ticket_color:f.elements.ticketColor.value});
  });
  document.querySelector('#ticketColor').addEventListener('change',event=>document.querySelector('#ticketColorPreview').style.setProperty('--preview-color',event.target.value));
  document.querySelector('#eventForm [name=day]').addEventListener('change',event=>{
    backedUpEventDay=null; document.querySelector('#deleteEvent').disabled=true;
    const e=eventSettings.find(e=>e.event_day===event.target.value);if(!e) return;
    const f=event.target.form;
    f.elements.eventName.value=e.name;f.elements.active.checked=e.active;f.elements.vipLimit.value=e.vip_limit;
    f.elements.regularLimit.value=e.regular_limit;f.elements.vipPrice.value=e.vip_price;f.elements.regularPrices.value=e.regular_prices.join(',');f.elements.ticketColor.value=safeTicketColor(e.ticket_color);document.querySelector('#ticketColorPreview').style.setProperty('--preview-color',f.elements.ticketColor.value);
  });
  document.querySelector('#backupEvent').addEventListener('click',async()=>{
    const f=document.querySelector('#eventForm'),day=f.elements.day.value,status=f.querySelector('[role=status]');
    if(!day || !eventSettings.some(e=>e.event_day===day)){status.textContent='กรุณาเลือกงานที่มีอยู่';return;}
    try {const backup=await rpc('backup_event',{p_event_day:day});const blob=new Blob([backupToXlsx(backup)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='event-backup-'+day+'.xlsx';link.click();URL.revokeObjectURL(url);backedUpEventDay=day;document.querySelector('#deleteEvent').disabled=false;status.textContent='ดาวน์โหลดข้อมูลสำรองแล้ว สามารถกดลบงานนี้ได้';}
    catch(error){status.textContent=error.message || 'สำรองข้อมูลไม่สำเร็จ';}
  });
  document.querySelector('#deleteEvent').addEventListener('click',async()=>{
    const f=document.querySelector('#eventForm'),day=f.elements.day.value,status=f.querySelector('[role=status]');
    if(backedUpEventDay!==day){status.textContent='กรุณาดาวน์โหลดข้อมูลสำรองของงานนี้ก่อน';return;}
    if(!confirm('ยืนยันลบงาน '+day+' และข้อมูลบัตร QR การชำระเงิน และเช็กอินทั้งหมดของวันนี้หรือไม่?')) return;
    try {await rpc('delete_event',{p_event_day:day,p_confirmation:'DELETE '+day});backedUpEventDay=null;document.querySelector('#deleteEvent').disabled=true;f.reset();status.textContent='ลบงานและข้อมูลเรียบร้อยแล้ว';await loadData();}
    catch(error){status.textContent=error.message || 'ลบงานไม่สำเร็จ';}
  });
  bind('paymentForm',async f=>{
    await rpc('set_ticket_payment',{p_ticket_id:f.elements.ticketId.value,p_status:f.elements.status.value,p_reference:f.elements.reference.value,p_amount:Number(f.elements.amount.value)});
    document.querySelector('#paymentDialog').close();
  });
  document.querySelector('#closePayment').addEventListener('click',()=>document.querySelector('#paymentDialog').close());
  document.querySelector('#paymentForm [name=status]').addEventListener('change',event=>{
    const f=event.target.form; const t=tickets.find(t=>t.id===f.elements.ticketId.value);
    f.elements.amount.value=event.target.value==='paid'?(t?.price || 0):0;
  });
});


function safeTicketColor(value) { const color=String(value || '').toLowerCase();return TICKET_COLORS.includes(color) ? color : '#0f766e'; }



