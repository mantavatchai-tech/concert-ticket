const QRCode=require('qrcode');
module.exports=async function handler(request,response) {
  if(request.method!=='GET') {response.setHeader('Allow','GET');return response.status(405).json({error:'Method not allowed'});}
  const code=String(request.query.code || '').trim().toUpperCase();
  if(!/^[A-F0-9]{32}$/.test(code)) return response.status(400).json({error:'Invalid QR token'});
  try {
    const png=await QRCode.toBuffer(code,{type:'png',width:900,margin:2,errorCorrectionLevel:'M'});
    response.setHeader('Content-Type','image/png');
    response.setHeader('Cache-Control','private, no-store');
    return response.status(200).send(png);
  } catch {return response.status(500).json({error:'Could not generate QR'});}
};
