async function rpc(name,body) {
  const response=await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',headers:{'Content-Type':'application/json',apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)
  });
  const data=await response.json();
  if(!response.ok) {const error=new Error(data.message || 'Database request failed');error.status=response.status;throw error;}
  return data;
}
module.exports=async function handler(request,response) {
  response.setHeader('Cache-Control','no-store');
  if(request.method!=='POST') {response.setHeader('Allow','POST');return response.status(405).json({error:'Method not allowed'});}
  const token=(request.headers.authorization || '').match(/^Bearer ([0-9a-f-]{36})$/i)?.[1];
  if(!token) return response.status(401).json({error:'กรุณาเข้าสู่ระบบ'});
  if(!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.APP_URL) {
    return response.status(503).json({error:'ยังไม่ได้ตั้งค่า LINE หรือ Supabase บน server'});
  }
  const ticketId=request.body?.ticketId;
  if(typeof ticketId!=='string' || !/^(VIP|REG)\d+$/.test(ticketId)) return response.status(400).json({error:'เลขบัตรไม่ถูกต้อง'});
  let prepared;
  try {
    const base=new URL(process.env.APP_URL);
    if(base.protocol!=='https:') throw new Error('APP_URL ต้องเป็น HTTPS');
    prepared=await rpc('prepare_line_delivery',{p_session_token:token,p_ticket_id:ticketId});
    if(prepared.status==='sent') return response.status(200).json({ok:true,alreadySent:true});
    const ticket=prepared.ticket;
    // Send only a capability link. Neither caller-supplied recipients nor QR payloads are accepted.
    const url=`${base.origin}/ticket.html#token=${encodeURIComponent(ticket.access_token)}`;
    const message=`บัตรคอนเสิร์ต ${ticket.id}\nวันงาน: ${ticket.event_day}\nประเภท: ${ticket.ticket_type}\nเปิด QR บัตรของคุณ: ${url}\nกรุณาเก็บลิงก์นี้เป็นความลับ`;
    const line=await fetch('https://api.line.me/v2/bot/message/push',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'X-Line-Retry-Key':prepared.retry_key},body:JSON.stringify({to:ticket.line_user_id,messages:[{type:'text',text:message}]}),signal:AbortSignal.timeout(10000)
    });
    const ok=line.ok || (line.status===409 && Boolean(line.headers.get('x-line-accepted-request-id')));
    await rpc('finish_line_delivery',{p_ticket_id:ticketId,p_retry_key:prepared.retry_key,p_ok:ok,p_error:ok?null:`LINE HTTP ${line.status}`});
    if(!ok) return response.status(502).json({error:`LINE ปฏิเสธคำขอ (${line.status}) กรุณาตรวจการตั้งค่าหรือทดลองส่งอีกครั้ง`});
    return response.status(200).json({ok:true});
  } catch(error) {
    if(prepared) {
      try {await rpc('finish_line_delivery',{p_ticket_id:ticketId,p_retry_key:prepared.retry_key,p_ok:false,p_error:'Delivery outcome uncertain; retry using the same key'});} catch {}
    }
    return response.status(error.status===401 || error.status===403 ? 403 : 503).json({error:'ยังยืนยันการส่งไม่ได้ โปรดตรวจสิทธิ์และการเชื่อมต่อ แล้วลองส่งรายการเดิมอีกครั้ง'});
  }
};
