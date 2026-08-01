# ระบบบัตรคอนเสิร์ตออนไลน์

เว็บแอปสำหรับออกบัตร, ส่ง QR ผ่าน LINE OA, เช็คอินผ่านมือถือ, กันสแกนซ้ำ และดู Dashboard แบบข้อมูลกลาง

## 1. ตั้งค่า Supabase

1. สร้างโปรเจกต์ที่ Supabase
2. ไปที่ SQL Editor
3. คัดลอกคำสั่งใน `supabase-schema.sql` ไปรัน
4. ไปที่ Project Settings > API
5. คัดลอก `Project URL` และ `anon public key`
6. สร้างไฟล์ `config.js` จาก `config.example.js` แล้วใส่ค่าจริง

```js
window.APP_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY",
};
```

## 2. ตั้งค่า LINE OA

ต้องใช้ LINE Messaging API channel access token

บน Vercel ให้ตั้ง Environment Variables:

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `ADMIN_PIN`
- `APP_URL` เช่น `https://your-site.vercel.app`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

ลูกค้าต้องเป็นเพื่อนกับ LINE OA หรือเคยคุยกับ OA ตามเงื่อนไขของ LINE ก่อน จึงจะรับ push message ได้

ตั้ง Webhook URL ใน LINE Developers Console เป็น:

```text
https://your-site.vercel.app/api/line-webhook
```

เมื่อคนแอดหรือทัก LINE OA ระบบจะบันทึก `line_user_id` ไว้ในตาราง `line_customers` และช่อง LINE userId ในหน้าออกบัตรจะมีรายการให้เลือก

## 3. Deploy ไป Vercel

1. อัปโหลด repo นี้ขึ้น GitHub
2. Import เข้า Vercel
3. ตั้ง Environment Variables ตามข้อ 2
4. Deploy

หลัง deploy แล้ว เปิด URL ด้วยมือถือ เจ้าหน้าที่สามารถสแกน QR ได้ผ่าน HTTPS

## 4. การใช้งาน

1. เลือกวันงานปัจจุบันด้านบน
2. กรอกชื่อเจ้าหน้าที่
3. ออกบัตรโดยเลือก VIP หรือ Regular และวันของบัตร
4. กรอก LINE userId ของลูกค้า แล้วติ๊กส่ง LINE
5. ลูกค้าจะได้รับข้อความและรูป QR ผ่าน LINE OA
6. หน้างานสแกน QR หรือกรอกรหัส QR

ระบบจะปฏิเสธอัตโนมัติถ้า:

- ไม่พบบัตร
- บัตรเป็นคนละวัน
- QR ถูกเช็คอินไปแล้ว

## หมายเหตุสำคัญ

เวอร์ชันนี้เปิดให้ทุกคนที่มี URL และ Supabase anon key อ่าน Dashboard และเรียกออกบัตรได้ผ่านหน้าเว็บ จึงควรวาง URL หลังระบบ login หรือเพิ่ม Supabase Auth ก่อนใช้กับทีมขนาดใหญ่
