const crypto=require('node:crypto');
async function readRawBody(request) {
  if(Buffer.isBuffer(request.body)) return request.body;
  if(typeof request.body==='string') return Buffer.from(request.body);
  if(request.body) throw new Error('Raw request body required');
  const chunks=[];let length=0;
  for await(const chunk of request) {
    length+=chunk.length;if(length>1024*1024) throw new Error('Body too large');chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function verify(raw,signature) {
  if(!process.env.LINE_CHANNEL_SECRET || typeof signature!=='string') return false;
  const digest=crypto.createHmac('sha256',process.env.LINE_CHANNEL_SECRET).update(raw).digest('base64');
  return Buffer.byteLength(digest)===Buffer.byteLength(signature) && crypto.timingSafeEqual(Buffer.from(digest),Buffer.from(signature));
}
async function upsertCustomer(event) {
  const userId=event.source?.userId;
  if(!/^U[0-9a-fA-F]{32}$/.test(userId || '')) return false;
  const profileResponse=await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`,{
    headers:{Authorization:`Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`},signal:AbortSignal.timeout(8000)
  });
  const profile=profileResponse.ok ? await profileResponse.json() : {};
  const payload={line_user_id:userId,last_event_type:event.type,last_seen_at:new Date().toISOString()};
  if(profile.displayName) payload.display_name=profile.displayName;
  if(profile.pictureUrl) payload.picture_url=profile.pictureUrl;
  if(event.type==='follow') payload.followed_at=new Date().toISOString();
  const headers={'Content-Type':'application/json',apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`};
  const create=await fetch(`${process.env.SUPABASE_URL}/rest/v1/line_customers?on_conflict=line_user_id`,{
    method:'POST',headers:{...headers,Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)
  });
  if(!create.ok) throw new Error('Customer save failed');
  const rows=await create.json();
  if(rows.length) return true;
  const update=await fetch(`${process.env.SUPABASE_URL}/rest/v1/line_customers?line_user_id=eq.${encodeURIComponent(userId)}`,{
    method:'PATCH',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)
  });
  if(!update.ok) throw new Error('Customer update failed');
  return false;
}
async function handler(request,response) {
  if(request.method!=='POST') {response.setHeader('Allow','POST');return response.status(405).json({error:'Method not allowed'});}
  try {
    const raw=await readRawBody(request);
    if(!verify(raw,request.headers['x-line-signature'])) return response.status(401).json({error:'Invalid LINE signature'});
    let body;try {body=JSON.parse(raw.toString('utf8'));} catch {return response.status(400).json({error:'Invalid JSON'});}
    if(!Array.isArray(body.events)) return response.status(400).json({error:'Invalid events'});
    if(body.events.length && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.LINE_CHANNEL_ACCESS_TOKEN)) return response.status(503).json({error:'Webhook not configured'});
    for(const event of body.events) {
      if(!['follow','message','unfollow'].includes(event.type)) continue;
      // A failed database write returns non-2xx so LINE can redeliver the event.
      const isNew=await upsertCustomer(event);
      if(isNew && event.replyToken && event.replyToken!=='00000000000000000000000000000000' && ['follow','message'].includes(event.type)) {
        const reply=await fetch('https://api.line.me/v2/bot/message/reply',{
          method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.LINE_CHANNEL_ACCESS_TOKEN},
          body:JSON.stringify({replyToken:event.replyToken,messages:[{type:'text',text:'รับข้อมูลแล้วค่ะ ต้องการซื้อบัตรคอนเสิร์ตวันไหนแจ้งแอดมินได้เลยค่ะ\nเมื่อตรวจสอบการชำระเงินเรียบร้อย ทีมงานจะส่งลิงก์ QR ให้ทางแชทนี้'}]}),signal:AbortSignal.timeout(8000)
        });
        // A greeting is best-effort. Customer data is already safely saved.
        if(!reply.ok) console.warn('LINE greeting was not accepted:',reply.status);
      }
    }
    return response.status(200).json({ok:true});
  } catch {
    return response.status(503).json({error:'Webhook processing failed; retry later'});
  }
}
module.exports=handler;
module.exports.config={api:{bodyParser:false}};
