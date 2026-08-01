const QRCode = require("qrcode");

module.exports = async function handler(request, response) {
  const code = String(request.query.code || "").trim().toUpperCase();
  if (!code) {
    response.status(400).json({ error: "Missing code" });
    return;
  }

  try {
    const png = await QRCode.toBuffer(code, {
      type: "png",
      width: 900,
      margin: 2,
      errorCorrectionLevel: "M",
      color: {
        dark: "#111827",
        light: "#ffffff",
      },
    });

    response.setHeader("Content-Type", "image/png");
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.status(200).send(png);
  } catch (error) {
    response.status(500).json({ error: "Could not generate QR" });
  }
};
