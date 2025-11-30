const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');

// Import module AI của bạn
// Giả định analyzePersonalPattern, predictNextValue, db, firestore được export từ './aiModule'
const { analyzePersonalPattern, predictNextValue, db, firestore } = require('./aiModule');

// Khởi tạo server
const app = express();
app.use(bodyParser.json());
app.use(cors());

// --- Cấu hình gửi email (Nodemailer) ---
// LƯU Ý: Cần cấu hình biến môi trường EMAIL_USER và EMAIL_PASSWORD
const transporter = nodemailer.createTransport({
    service: 'gmail', // Hoặc SMTP server khác
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

/**
 * Hàm gửi email cảnh báo.
 * @param {string} to - Địa chỉ email người nhận.
 * @param {string} subject - Chủ đề email.
 * @param {string} text - Nội dung email.
 */
async function sendAlertEmail(to, subject, text) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        console.error("Lỗi: Thiếu cấu hình EMAIL_USER hoặc EMAIL_PASSWORD.");
        return; // Không gửi email nếu thiếu cấu hình
    }
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to,
        subject,
        text
    };
    // Sử dụng try/catch để xử lý lỗi gửi email mà không làm crash endpoint
    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('Email sent: ' + info.response);
    } catch (error) {
        console.error("Lỗi khi gửi email:", error);
    }
}

// ----------------------------------------------------------------------
// --- Endpoint phân tích dữ liệu và lưu alert (/analyze) ---
// ----------------------------------------------------------------------
app.post('/analyze', async (req, res) => {
    const { data, history, age, underlyingConditions, alertEmail } = req.body;

    // 🚩 Sửa lỗi: Thêm kiểm tra dữ liệu đầu vào cần thiết
    if (!data || !data.deviceID || !history) {
        return res.status(400).json({ error: 'Thiếu dữ liệu bắt buộc (data, data.deviceID, hoặc history).' });
    }

    try {
        // Gọi hàm AI
        const result = analyzePersonalPattern(data, history, age, underlyingConditions);

        // Nếu có cảnh báo và có email người nhận, gửi email.
        // **LƯU Ý QUAN TRỌNG:** alertEmail đã được lấy từ req.body (đã giải quyết lỗi thiếu khai báo)
        if (result && result.alerts && result.alerts.length > 0 && alertEmail) {
            const subject = `⚠️ AI Health Alert - Risk: ${result.riskText || 'Unknown'}`;
            const text = result.alerts.join('\n');
            await sendAlertEmail(alertEmail, subject, text); // ✅ Đã thêm 'await'
        }

        // --- Lưu vào Database ---
        const timestamp = Date.now();
        const deviceID = data.deviceID; // Sử dụng biến riêng cho deviceID

        // 1. Lưu vào Realtime Database (RTDB)
        await db.ref(`history/${deviceID}/alerts/${timestamp}`).set(result);
        
        // 2. Lưu vào Firestore (Sử dụng ID là timestamp string)
        await firestore.collection('alerts').doc(String(timestamp)).set(result);

        // Trả kết quả về client
        res.json(result);
    } catch (err) {
        // Xử lý lỗi
        console.error("Lỗi trong /analyze:", err);
        res.status(500).json({ 
            error: 'Lỗi server trong quá trình phân tích.', 
            details: err.message 
        });
    }
});

// ----------------------------------------------------------------------
// --- Endpoint dự đoán giá trị tiếp theo (/predict) ---
// ----------------------------------------------------------------------
app.post('/predict', (req, res) => {
    const { history, key, windowSize } = req.body;
    
    // 🚩 Thêm kiểm tra dữ liệu đầu vào
    if (!history || !key) {
        return res.status(400).json({ error: 'Thiếu dữ liệu bắt buộc (history hoặc key).' });
    }

    try {
        // windowSize mặc định là 10 nếu không có
        const size = windowSize || 10; 
        const prediction = predictNextValue(history, key, size);
        res.json({ prediction });
    } catch (err) {
        console.error("Lỗi trong /predict:", err);
        res.status(500).json({ 
            error: 'Lỗi server trong quá trình dự đoán.', 
            details: err.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI backend running on port ${PORT}`));