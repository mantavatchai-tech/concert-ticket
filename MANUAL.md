# คู่มือสร้างเว็บแอปบัตรคอนเสิร์ตออนไลน์

คู่มือนี้อธิบายการสร้างและติดตั้งเว็บแอปบัตรคอนเสิร์ตชุดนี้ตั้งแต่เริ่มต้นจนใช้งานจริง ครอบคลุมการตั้งค่า Supabase, LINE OA, Vercel, การอัปเดตไฟล์, การทดสอบ และการดูแลระบบหลังเปิดใช้งาน

## 1. ภาพรวมระบบ

เว็บแอปนี้ใช้สำหรับออกบัตรคอนเสิร์ต, สร้าง QR Code, ส่งบัตรให้ลูกค้าทาง LINE OA, เช็คอินหน้างาน และดูรายการบัตรที่ออกแล้ว

ส่วนประกอบหลัก:

- `index.html` คือหน้าแอดมินสำหรับออกบัตร, เช็คอิน และดู Dashboard
- `app.js` คือ logic หลักของหน้าแอดมิน
- `ticket.html` คือหน้าบัตรสำหรับลูกค้าเปิดดู QR
- `ticket.js` คือ logic ของหน้าบัตรลูกค้า
- `styles.css` คือหน้าตาเว็บ
- `config.js` คือค่าการเชื่อมต่อ Supabase ฝั่งหน้าเว็บ
- `supabase-schema.sql` คือ SQL สำหรับสร้างฐานข้อมูลใหม่
- `update-event-dates.sql` คือ SQL สำหรับอัปเดตฐานข้อมูลเดิม
- `api/send-line-ticket.js` คือ API ส่งบัตรผ่าน LINE OA
- `api/line-webhook.js` คือ API รับ webhook จาก LINE OA
- `api/qr.js` คือ API สร้างรูป QR

## 2. สิ่งที่ต้องมี

ต้องมีบัญชีและบริการเหล่านี้:

1. Supabase สำหรับเก็บข้อมูลบัตรและเช็คอิน
2. LINE Developers และ LINE Official Account สำหรับส่งบัตรทาง LINE
3. GitHub สำหรับเก็บโค้ดเว็บ
4. Vercel สำหรับ deploy เว็บ
5. คอมพิวเตอร์ที่มีไฟล์โปรเจกต์นี้

โฟลเดอร์โปรเจกต์ควรมีไฟล์ประมาณนี้:

```text
บัตรคอนเสิร์ต/
  api/
    line-webhook.js
    qr.js
    send-line-ticket.js
  app.js
  config.example.js
  config.js
  index.html
  package.json
  README.md
  styles.css
  supabase-schema.sql
  ticket.html
  ticket.js
  update-event-dates.sql
```

## 3. สร้างฐานข้อมูล Supabase

ใช้ขั้นตอนนี้เมื่อสร้างระบบใหม่ครั้งแรก

1. เข้าเว็บไซต์ Supabase
2. สร้าง Project ใหม่
3. รอให้ Project สร้างเสร็จ
4. เข้าเมนู `SQL Editor`
5. กด `New query`
6. เปิดไฟล์ `supabase-schema.sql`
7. คัดลอก SQL ทั้งไฟล์ไปวางใน Supabase
8. กด `Run`

หลังรันสำเร็จ Supabase จะมีตารางหลัก:

- `ticket_counters` เก็บเลขรันนิ่งของบัตร VIP และ Regular
- `tickets` เก็บข้อมูลบัตร เช่น เลขบัตร, ประเภท, ราคา, วันงาน, ชื่อลูกค้า
- `ticket_codes` เก็บรหัส QR แต่ละใบ
- `checkins` เก็บประวัติการเช็คอิน
- `line_customers` เก็บ LINE userId ของลูกค้าที่แอดหรือทัก OA

## 4. ตั้งค่า config.js

ไฟล์ `config.js` ใช้ให้หน้าเว็บเชื่อมต่อ Supabase

1. เข้า Supabase
2. ไปที่ `Project Settings`
3. ไปที่ `API`
4. คัดลอก `Project URL`
5. คัดลอก `anon public key` หรือ publishable key
6. เปิดไฟล์ `config.js`
7. ใส่ค่าจริงในรูปแบบนี้:

```js
window.APP_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY",
};
```

ตัวอย่าง:

```js
window.APP_CONFIG = {
  supabaseUrl: "https://xxxxxxxxxxxx.supabase.co",
  supabaseAnonKey: "sb_publishable_xxxxxxxxxxxx",
};
```

อย่าใส่ `service_role key` ใน `config.js` เพราะไฟล์นี้ถูกโหลดใน browser และคนอื่นสามารถเห็นได้

## 5. ตั้งค่า LINE OA

ต้องใช้ LINE Messaging API เพื่อส่งบัตรให้ลูกค้า

1. เข้า LINE Developers Console
2. สร้าง Provider ถ้ายังไม่มี
3. สร้าง Messaging API Channel
4. ผูกกับ LINE Official Account
5. ไปที่หน้า Channel settings
6. คัดลอก `Channel access token`
7. คัดลอก `Channel secret`

ใน LINE Developers ให้ตั้ง Webhook URL เป็น:

```text
https://your-site.vercel.app/api/line-webhook
```

หลัง deploy เว็บจริงแล้ว ให้เปลี่ยน `your-site.vercel.app` เป็น URL จริงของเว็บ

ควรเปิดใช้งาน:

- Use webhook: เปิด
- Auto-reply messages: ปิดหรือปรับตามต้องการ
- Greeting messages: ตั้งได้ตามต้องการ

เมื่อมีลูกค้าแอดหรือทัก LINE OA ระบบจะบันทึก `line_user_id` ลงตาราง `line_customers` แล้วหน้าออกบัตรจะมีรายการให้เลือก

## 6. ตั้งค่า Environment Variables บน Vercel

ค่าเหล่านี้ใช้เฉพาะฝั่ง server/API บน Vercel

เข้า Vercel Project แล้วไปที่:

```text
Settings > Environment Variables
```

เพิ่มค่าเหล่านี้:

```text
LINE_CHANNEL_ACCESS_TOKEN
LINE_CHANNEL_SECRET
ADMIN_PIN
APP_URL
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

คำอธิบาย:

- `LINE_CHANNEL_ACCESS_TOKEN` คือ token จาก LINE Developers
- `LINE_CHANNEL_SECRET` คือ secret จาก LINE Developers
- `ADMIN_PIN` คือรหัสแอดมินสำหรับอนุญาตส่ง LINE
- `APP_URL` คือ URL เว็บ เช่น `https://your-site.vercel.app`
- `SUPABASE_URL` คือ Project URL ของ Supabase
- `SUPABASE_SERVICE_ROLE_KEY` คือ key ฝั่ง server สำหรับ webhook เขียนข้อมูลลูกค้า LINE

ห้ามใส่ `SUPABASE_SERVICE_ROLE_KEY` ใน `config.js`

## 6.1 เพิ่มระบบ Login และสิทธิ์ผู้ใช้

หลัง deploy เวอร์ชันที่มีระบบ login ให้รันไฟล์นี้ใน Supabase SQL Editor:

```text
admin-features.sql
```

ถ้ามีการรันไฟล์ migration เก่า เช่น `update-event-dates.sql` ให้รัน `admin-features.sql` เป็นไฟล์สุดท้ายเสมอ เพราะไฟล์นี้จะสร้าง RPC เวอร์ชันที่บังคับ login และสิทธิ์ผู้ใช้

ไฟล์นี้จะเพิ่ม:

- ตาราง `admin_users` สำหรับบัญชีผู้ใช้
- ตาราง `admin_sessions` สำหรับ session หลัง login
- ตาราง `ticket_audit_logs` สำหรับประวัติการแก้ไข
- สถานะยกเลิกบัตรในตาราง `tickets`
- ฟังก์ชัน login, logout, แก้ราคา, ยกเลิกบัตร
- การบังคับสิทธิ์ตอนออกบัตรและเช็คอิน

หลังรัน SQL แล้ว ระบบจะสร้างผู้ใช้เริ่มต้นให้ 3 บัญชี:

| Username | Password | Role | ใช้สำหรับ |
| --- | --- | --- | --- |
| `admin` | `Admin@1234` | `admin` | ทำได้ทุกอย่าง |
| `issuer` | `Issuer@1234` | `issuer` | ออกบัตร, แก้ราคา, ยกเลิกบัตร, Export รายงาน |
| `checkin` | `Checkin@1234` | `checkin` | เช็คอินอย่างเดียว |

ควรเปลี่ยน password ก่อนใช้งานจริง

Role ที่ใช้ได้:

- `admin` ใช้งานได้ทุกอย่าง
- `issuer` ออกบัตร, แก้ราคา, ยกเลิกบัตร, Export รายงาน
- `checkin` เช็คอินได้อย่างเดียว

ตัวอย่างเปลี่ยน password:

```sql
update public.admin_users
set password_hash = extensions.crypt('NEW_STRONG_PASSWORD', extensions.gen_salt('bf'))
where username = 'admin';
```

## 7. Deploy เว็บไป Vercel

วิธีแนะนำคือใช้ GitHub + Vercel

1. สร้าง repository บน GitHub
2. อัปโหลดไฟล์ทั้งหมดของโปรเจกต์ขึ้น GitHub
3. เข้า Vercel
4. กด `Add New Project`
5. เลือก repository นี้
6. ตั้งค่า Environment Variables ตามหัวข้อก่อนหน้า
7. กด Deploy

หลัง deploy สำเร็จ จะได้ URL ประมาณ:

```text
https://your-site.vercel.app
```

ให้นำ URL นี้ไปใส่ใน:

- `APP_URL` บน Vercel
- Webhook URL ใน LINE Developers

หลังแก้ Environment Variables แล้วควร redeploy อีกครั้ง

## 8. วิธีอัปเดตเว็บหลังแก้ไฟล์

ถ้าแก้แค่หน้าเว็บ เช่น `index.html`, `app.js`, `styles.css`, `ticket.html`, `ticket.js`:

1. เอาไฟล์ใหม่ไปวางทับไฟล์เดิมในโปรเจกต์
2. อัปโหลดขึ้น GitHub
3. Vercel จะ deploy ใหม่อัตโนมัติ หรือกด Redeploy เอง
4. เปิดเว็บแล้วกด refresh

ถ้าแก้ SQL:

1. เปิดไฟล์ SQL ที่ต้องใช้ เช่น `update-event-dates.sql`
2. เข้า Supabase `SQL Editor`
3. วาง SQL ทั้งไฟล์
4. กด `Run`
5. ค่อย deploy ไฟล์เว็บถ้ามีการแก้หน้าเว็บด้วย

ตัวอย่างการอัปเดตราคา Regular 150/180:

- ต้อง deploy `index.html`
- ต้อง deploy `app.js`
- ต้องรัน `update-event-dates.sql` ใน Supabase

ตัวอย่างการแก้ไม่ให้เช็คอินถ้าไม่กรอกชื่อเจ้าหน้าที่:

- ต้อง deploy `index.html`
- ต้อง deploy `app.js`
- ไม่ต้องรัน SQL

ตัวอย่างการแก้ไม่ให้ออกบัตรถ้าไม่กรอกรหัสแอดมิน:

- ต้อง deploy `app.js`
- ไม่ต้องรัน SQL

ตัวอย่างการแก้ข้อความหรือสิทธิ์ที่ถูกบันทึกตอนออกบัตร เช่น สิทธิ์ VIP:

- ถ้าแก้ข้อความหน้าเว็บอย่างเดียว ให้ deploy `index.html`
- ถ้าแก้ข้อความที่ระบบบันทึกลงบัตรตอนออกบัตรใหม่ ต้องรัน SQL ที่แก้ฟังก์ชันใน Supabase ด้วย เช่น `admin-features.sql`
- ถ้าต้องการแก้บัตรเก่าที่ออกไปแล้ว ต้องรัน `update public.tickets ...` เพื่อเปลี่ยนข้อมูลเดิมในตาราง `tickets`

ตัวอย่างแก้สิทธิ์ VIP เดิมให้เป็น `พร้อมเครื่องดื่ม`:

```sql
update public.tickets
set perks = 'พร้อมเครื่องดื่ม'
where ticket_type = 'VIP'
  and perks in ('เบียร์ 6 กระป๋อง, น้ำแข็ง 1 ชุด', 'เครื่องดื่ม');
```

## 9. วิธีใช้งานหน้าแอดมิน

เปิด URL หลักของเว็บ:

```text
https://your-site.vercel.app
```

ขั้นตอนออกบัตร:

1. เลือกประเภทบัตร `VIP` หรือ `Regular`
2. ถ้าเลือก `Regular` ให้เลือกราคา `150` หรือ `180`
3. ใส่จำนวนบัตร Regular ที่ต้องการ
4. เลือกวันของบัตร
5. กรอกชื่อลูกค้า
6. กรอกหรือเลือก `LINE userId`
7. ถ้าจะส่ง LINE ให้ติ๊ก `ส่ง QR ให้ลูกค้าทาง LINE OA หลังออกบัตร`
8. กรอกรหัสแอดมิน
9. กด `สร้างบัตร`

กติกาที่ระบบใช้:

- VIP ราคา 2,000 บาท
- VIP 1 ใบมี 4 QR
- VIP จำกัด 30 ใบ
- VIP แสดงสิทธิ์เป็น `พร้อมเครื่องดื่ม`
- Regular เลือกราคาได้ 150 หรือ 180 บาท
- Regular 1 ใบมี 1 QR
- ถ้าติ๊กส่ง LINE แต่ไม่กรอกรหัสแอดมิน ระบบจะไม่สร้างบัตร

## 10. วิธีเช็คอินหน้างาน

ก่อนเช็คอินต้องกรอกชื่อเจ้าหน้าที่ก่อนเสมอ

ขั้นตอน:

1. เลือกวันงานปัจจุบันด้านบน
2. กรอกชื่อเจ้าหน้าที่
3. กดเปิดกล้องเพื่อสแกน QR หรือกรอกรหัส QR เอง
4. ระบบตรวจสอบ QR
5. ถ้าถูกต้อง ระบบจะบันทึกเช็คอิน

ระบบจะปฏิเสธอัตโนมัติถ้า:

- ไม่กรอกชื่อเจ้าหน้าที่
- ไม่พบ QR
- บัตรเป็นคนละวัน
- ยังไม่ถึงวันจริงของบัตรตามเวลาไทย
- QR ถูกเช็คอินไปแล้ว

## 11. วิธีดูและส่งหน้าบัตรลูกค้า

เมื่อลูกค้าได้รับข้อความ LINE จะมีลิงก์หน้าบัตร เช่น:

```text
https://your-site.vercel.app/ticket.html?id=REG0001
```

ลูกค้าเปิดลิงก์นี้เพื่อดู QR ได้

หน้าบัตรลูกค้าใช้ไฟล์:

- `ticket.html`
- `ticket.js`
- `styles.css`
- `/api/qr`

ถ้าภายหลังแก้ราคาบัตรใน Supabase หน้าบัตรลูกค้าจะดึงราคาล่าสุดเมื่อเปิดหน้าใหม่

## 12. แก้ไขบัตรที่ออกผิด

ถ้าออก Regular ผิดราคา เช่น ตั้งใจออก 150 แต่กด 180 ให้แก้ที่ Supabase

ดูบัตรล่าสุด:

```sql
select id, ticket_type, event_day, buyer_name, price, issued_at
from public.tickets
order by issued_at desc
limit 20;
```

แก้จาก 180 เป็น 150:

```sql
update public.tickets
set price = 150
where id = 'REG0007'
  and ticket_type = 'Regular'
  and price = 180;
```

แก้จาก 150 เป็น 180:

```sql
update public.tickets
set price = 180
where id = 'REG0007'
  and ticket_type = 'Regular'
  and price = 150;
```

ไม่ต้องแก้ตาราง `ticket_codes` เพราะ QR ยังเป็นรหัสเดิม ใช้งานต่อได้

## 13. การทดสอบก่อนใช้งานจริง

ก่อนเปิดขายหรือเปิดใช้งานจริง ควรทดสอบตามนี้:

1. เปิดหน้าเว็บแล้วตรวจว่าไม่มีข้อความเตือน `ยังไม่ได้ตั้งค่า Supabase`
2. ออกบัตร Regular ราคา 150 ได้
3. ออกบัตร Regular ราคา 180 ได้
4. ออกบัตร VIP ได้
5. ถ้าไม่กรอกรหัสแอดมินและติ๊กส่ง LINE ระบบต้องไม่สร้างบัตร
6. ถ้าไม่กรอกชื่อเจ้าหน้าที่ ระบบต้องไม่ให้เช็คอิน
7. QR ที่เช็คอินแล้วต้องเช็คอินซ้ำไม่ได้
8. บัตรคนละวันต้องเข้าไม่ได้
9. บัตรวันอนาคตต้องยังเช็คอินไม่ได้
10. ลูกค้าเปิด `ticket.html` ได้
11. LINE OA ส่งข้อความและรูป QR ได้

ตรวจ syntax ของโค้ดด้วยคำสั่ง:

```text
npm.cmd run check
```

ถ้าใช้ PowerShell แล้ว `npm run check` ติด execution policy ให้ใช้ `npm.cmd run check` แทน

## 14. การดูแลความปลอดภัย

คำแนะนำสำคัญ:

- อย่าใส่ `service_role key` ในไฟล์หน้าเว็บ
- ใช้ `ADMIN_PIN` สำหรับการส่ง LINE
- ควรเพิ่มระบบ login หน้าแอดมินก่อนใช้งานกับทีมหลายคน
- ไม่ควรล็อก `ticket.html` เพราะลูกค้าต้องเปิดดูบัตรจาก LINE
- ไม่ควรล็อก `/api/qr` เพราะหน้าบัตรต้องโหลดรูป QR
- ควรล็อกเฉพาะหน้าแอดมิน เช่น `index.html`

ถ้าจะเพิ่ม login แนะนำให้ล็อก:

- หน้าออกบัตร
- Dashboard
- หน้าเช็คอิน

แต่ไม่ล็อก:

- `ticket.html`
- `ticket.js`
- `/api/qr`
- `/api/line-webhook`

## 15. วิธีสำรองข้อมูล

ควรสำรองข้อมูลจาก Supabase เป็นระยะ โดยเฉพาะก่อนวันงาน

ข้อมูลที่ควร export:

- `tickets`
- `ticket_codes`
- `checkins`
- `line_customers`

วิธีง่าย:

1. เข้า Supabase
2. ไปที่ Table Editor
3. เลือกตาราง
4. Export เป็น CSV ถ้ามีเมนูให้เลือก

หรือใช้ SQL:

```sql
select * from public.tickets order by issued_at desc;
select * from public.ticket_codes order by ticket_id, seat_no;
select * from public.checkins order by checked_in_at desc;
select * from public.line_customers order by last_seen_at desc;
```

## 16. ปัญหาที่พบบ่อย

เปิดเว็บแล้วขึ้นว่ายังไม่ได้ตั้งค่า Supabase:

- ตรวจ `config.js`
- ตรวจ `supabaseUrl`
- ตรวจ `supabaseAnonKey`
- deploy ไฟล์ `config.js` แล้วหรือยัง

ออกบัตรราคา 180 ไม่ได้:

- ต้องรัน `update-event-dates.sql` ใน Supabase
- ตรวจว่า deploy `app.js` และ `index.html` ใหม่แล้ว

ออก VIP ใหม่แล้วยังขึ้นสิทธิ์เก่า เช่น เบียร์/น้ำแข็ง:

- แปลว่า Supabase ยังใช้ฟังก์ชัน `issue_ticket` เวอร์ชันเก่า
- ให้รัน `admin-features.sql` เวอร์ชันล่าสุดใน Supabase อีกครั้ง
- ตรวจว่าในไฟล์มีบรรทัด `v_perks := 'พร้อมเครื่องดื่ม';`
- ถ้าบัตรที่ออกไปแล้วต้องการแก้ด้วย ให้รัน SQL อัปเดต `public.tickets.perks`

ส่ง LINE ไม่ได้:

- ตรวจ `ADMIN_PIN`
- ตรวจ `LINE_CHANNEL_ACCESS_TOKEN`
- ตรวจ `LINE_CHANNEL_SECRET`
- ตรวจ `APP_URL`
- ตรวจว่าลูกค้าเคยแอดหรือทัก LINE OA แล้ว

Webhook LINE ไม่ทำงาน:

- ตรวจ Webhook URL ต้องเป็น `/api/line-webhook`
- ตรวจว่าเปิด Use webhook ใน LINE Developers
- ตรวจ Environment Variables บน Vercel

สแกนกล้องไม่ได้:

- ต้องเปิดเว็บผ่าน HTTPS
- browser ต้องได้รับอนุญาตใช้กล้อง
- ถ้ากล้องใช้ไม่ได้ ให้กรอกรหัส QR เอง

เช็คอินไม่ได้:

- ตรวจว่ากรอกชื่อเจ้าหน้าที่แล้ว
- ตรวจว่าวันงานด้านบนตรงกับวันของบัตร
- ตรวจว่า QR ยังไม่เคยเช็คอิน

## 17. Checklist ก่อนวันงาน

ก่อนวันงานควรเช็ค:

- Supabase ใช้งานได้
- Vercel deploy ล่าสุดแล้ว
- LINE OA ส่งข้อความได้
- QR แสดงในมือถือได้
- ทีมงานรู้รหัสแอดมิน
- ทีมงานรู้วิธีกรอกชื่อเจ้าหน้าที่ก่อนเช็คอิน
- มือถือหน้างานเปิดกล้องผ่าน browser ได้
- มีวิธีกรอกรหัส QR เองสำรอง
- สำรองข้อมูลบัตรล่าสุดแล้ว

## 18. Checklist หลังแก้ระบบแต่ละครั้ง

ทุกครั้งที่แก้ไฟล์:

1. รัน `npm.cmd run check`
2. Deploy ไฟล์ที่แก้
3. เปิดเว็บจริง
4. ทดสอบ workflow ที่แก้
5. ถ้าแก้ SQL ให้รันใน Supabase ด้วย
6. จดว่าเปลี่ยนอะไรและวันที่เปลี่ยน

## 19. หมายเหตุสำหรับการพัฒนาต่อ

ฟีเจอร์ที่ควรเพิ่มในอนาคต:

- ระบบ login สำหรับหน้าแอดมิน
- ปุ่มแก้ราคาบัตรจากหน้าเว็บ
- ปุ่มยกเลิกบัตร
- บันทึกประวัติว่าใครแก้ไขบัตร
- Export รายงานยอดขาย
- แยกสิทธิ์คนออกบัตรกับคนเช็คอิน

ถ้าเพิ่ม login ควรออกแบบให้ลูกค้ายังเปิดหน้าบัตรได้ตามปกติ ไม่อย่างนั้นลิงก์ที่ส่งทาง LINE จะใช้งานไม่ได้
