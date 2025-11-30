const { mean, std } = require('./services/mathUtils');

// --- 1. KHỞI TẠO FIREBASE ADMIN SDK ---
const admin = require('firebase-admin');

// Đảm bảo rằng file này được chạy trong môi trường Node.js (backend) 
// và các biến môi trường FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY đã được thiết lập.
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: "caretrack-1338f",
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            // Thay thế chuỗi '\n' thành ký tự xuống dòng thực tế
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        }),
        databaseURL: "https://caretrack-1338f-default-rtdb.asia-southeast1.firebasedatabase.app"
    });
}

const db = admin.database();
const firestore = admin.firestore();

// --- HÀM HỖ TRỢ CHUYỂN ĐỔI/TÍNH TOÁN ---

function calculateRoC(currentData, history, param) {
    if (!history || history.length < 1) return 0;
    const previousRecord = history[history.length - 1];
    const V_hien_tai = currentData[param];
    const V_truoc = previousRecord[param];
    if (V_truoc === 0 || V_hien_tai === 0) return 0;
    return (V_hien_tai - V_truoc) / V_truoc;
}

function getTimeSlot(date) {
    const hour = date.getHours();
    if (hour >= 0 && hour < 6) return 'Night';
    if (hour >= 6 && hour < 12) return 'Morning';
    if (hour >= 12 && hour < 18) return 'Afternoon';
    return 'Evening';
}

// --- Adaptive thresholds theo tuổi/bệnh nền ---

function getAdaptiveThresholds(age = 30, underlyingConditions = {}) {
    let BPM_HIGH = 100, BPM_LOW = 50, HRV_CRITICAL = 2.5;
    let TEMP_HIGH = 38.5, SPO2_LOW = 94;

    if (age <= 12) {       // Trẻ em: Nhịp tim thường cao hơn
        BPM_HIGH = 120; BPM_LOW = 70; HRV_CRITICAL = 2.0; TEMP_HIGH = 38.0;
    } else if (age <= 18) { // Thiếu niên
        BPM_HIGH = 110; BPM_LOW = 60; HRV_CRITICAL = 2.2; TEMP_HIGH = 38.0;
    } else if (age <= 40) { // Người lớn trẻ
        BPM_HIGH = 100; BPM_LOW = 50; HRV_CRITICAL = 2.5;
    } else if (age <= 60) { // Trung niên
        BPM_HIGH = 100; BPM_LOW = 50; HRV_CRITICAL = 2.5;
    } else {                // Cao tuổi: Nhịp tim tối đa giảm, nhịp tim nghỉ ngơi tăng
        BPM_HIGH = 95; BPM_LOW = 55; HRV_CRITICAL = 2.5;
    }

    if (underlyingConditions.heartDisease) { 
        BPM_HIGH -= 5; 
        HRV_CRITICAL = 2.0; // Ngưỡng HRV nghiêm trọng hơn
    }
    if (underlyingConditions.hypertension) { 
        BPM_HIGH += 5;      // Có thể tăng ngưỡng trên của BPM do tăng huyết áp
    }

    return { BPM_HIGH, BPM_LOW, HRV_CRITICAL, TEMP_HIGH, SPO2_LOW };
}
// --- HÀM PHÂN TÍCH CHÍNH ---

function analyzePersonalPattern(data, history, age = 30, underlyingConditions = {}) {
    const MIN_DATA_POINTS = 10;
    const Z_SCORE_BPM_CRITICAL = 3.0;
    const ROC_BPM_CRITICAL = 0.35;
    const ACC_FALL_THRESHOLD = 12;

    const alerts = [];
    let risk = 0;
    let riskText = "Bình thường"; // Dùng 'let' là đúng

    const { BPM_HIGH, BPM_LOW, HRV_CRITICAL, TEMP_HIGH, SPO2_LOW } = getAdaptiveThresholds(age, underlyingConditions);

    const currentDate = new Date(); 
    const currentSlot = getTimeSlot(currentDate); 

    let slotHistory = history.filter(h => h.timestamp && getTimeSlot(new Date(parseInt(h.timestamp))) === currentSlot);

    // Fallback: mở rộng sang 1-2 ngày gần nhất cùng khung giờ nếu thiếu dữ liệu
    if (slotHistory.length < MIN_DATA_POINTS) {
        const lastDays = 2*24*60*60*1000;
        slotHistory = history.filter(h => {
            if (!h.timestamp) return false;
            const ts = parseInt(h.timestamp);
            const sameSlot = getTimeSlot(new Date(ts)) === currentSlot;
            const recent = ts >= (currentDate.getTime() - lastDays);
            return sameSlot && recent;
        });
    }

    const bpmList = slotHistory.map(h => h.bpm).filter(v => v != null);
    const hrvList = slotHistory.map(h => h.hrv).filter(v => v != null);
    const tempList = slotHistory.map(h => h.temp).filter(v => v != null);
    const spO2List = slotHistory.map(h => h.spO2).filter(v => v != null);

    if (bpmList.length < MIN_DATA_POINTS || hrvList.length < MIN_DATA_POINTS) {
        return { alerts, risk: 5, info: `Chưa đủ dữ liệu (yêu cầu ${MIN_DATA_POINTS}) để học thói quen khung giờ ${currentSlot}` };
    }

    const bpmMean = mean(bpmList);
    const bpmStd = std(bpmList);
    const hrvMean = mean(hrvList);
    const hrvStd = std(hrvList);
    const tempMean = mean(tempList);
    const spO2Mean = spO2List.length ? mean(spO2List) : null;

    const RoC_BPM = calculateRoC(data, history, 'bpm'); 
    const isResting = data.isResting || (data.totalAcc && data.totalAcc < ACC_FALL_THRESHOLD);

    const recentBPM = history.slice(-2).map(h => h.bpm).filter(v => v != null);
    recentBPM.push(data.bpm);
    const Count_Abnormal_Recent = recentBPM.filter(v => v > BPM_HIGH || v < BPM_LOW).length;

    // --- Nhịp tim ---
    if (data.bpm != null && bpmStd > 0) {
        const bpmZScore = (data.bpm - bpmMean) / bpmStd;
        if (bpmZScore > Z_SCORE_BPM_CRITICAL || data.bpm > BPM_HIGH) {
            alerts.push(`⚠️ Nhịp tim (${data.bpm} bpm) cao bất thường.`);
            risk += 40;
        }
        if (bpmZScore < -Z_SCORE_BPM_CRITICAL || data.bpm < BPM_LOW) {
            alerts.push(`⚠️ Nhịp tim (${data.bpm} bpm) thấp bất thường.`);
            risk += 40;
        }
    }

    // --- HRV ---
    if (data.hrv != null && hrvStd > 0) {
        const hrvZScore = (data.hrv - hrvMean) / hrvStd;
        if (hrvZScore < -HRV_CRITICAL) {
            alerts.push(`⚠️ HRV (${data.hrv}) rất thấp. Nguy cơ stress cấp.`);
            risk += 50;
        }
    }

    // --- Nhịp tim đột ngột khi nghỉ ---
    if (RoC_BPM > ROC_BPM_CRITICAL && isResting && data.bpm > BPM_HIGH) {
        alerts.push(`⚡️ Tăng nhịp tim đột ngột ${(RoC_BPM * 100).toFixed(0)}% khi nghỉ.`);
        risk += 60;
        // Loại bỏ: riskText = "Nguy cơ cấp tính";
    }

    // --- Sốt + nhịp tim bất thường ---
    if (data.temp != null && data.bpm != null && bpmStd > 0) {
        const bpmZScore = (data.bpm - bpmMean) / bpmStd;
        if (data.temp > TEMP_HIGH && (bpmZScore > 2 || bpmZScore < -2)) {
            alerts.push(`⚠️ Sốt cao (${data.temp}°C) + Nhịp tim bất thường.`);
            risk += 70;
            // Loại bỏ: riskText = "Rủi ro Y tế";
        }
    }

    // --- SpO2 thấp ---
    if (data.spO2 != null && data.spO2 < SPO2_LOW) {
        alerts.push(`⚠️ SpO2 thấp (${data.spO2}%). Nguy cơ thiếu oxy.`);
        risk += 60;
        // Loại bỏ: riskText = "Rủi ro Y tế";
    }

    // --- Té ngã / Acc mạnh ---
    if (data.fall?.totalAcc > ACC_FALL_THRESHOLD || data.fall?.status === "Té ngã") {
        alerts.push(`🚨 Phát hiện té ngã hoặc chuyển động mạnh bất thường!`);
        risk += 80;
        // Loại bỏ: riskText = "Khẩn cấp (Té ngã)";
    }

    // --- Cập nhật riskText ưu tiên cảnh báo cao nhất ---
    // Chỉ giữ lại logic này để quyết định RiskText cuối cùng dựa trên tổng điểm 'risk'.
    if (risk >= 80) riskText = "Khẩn cấp";
    else if (risk >= 60) riskText = "Rủi ro cao";
    else if (risk >= 40) riskText = "Cần theo dõi sát";

    return {
        alerts,
        risk: Math.min(risk, 100),
        riskText,
        pattern: {
            currentSlot,
            bpmMean: parseFloat(bpmMean.toFixed(1)),
            bpmStd: parseFloat(bpmStd.toFixed(1)),
            hrvMean: parseFloat(hrvMean.toFixed(1)),
            hrvStd: parseFloat(hrvStd.toFixed(1)),
            spO2Mean: spO2Mean != null ? parseFloat(spO2Mean.toFixed(1)) : null,
            Count_Abnormal_Recent
        }
    };
}

// --- WMA Prediction ---

function predictNextValue(history, key = "bpm", windowSize = 5) {
    const values = history.map(h => h[key]).filter(v => v != null);
    if (!values.length) return null;
    const recent = values.slice(-windowSize);
    let weightedSum = 0, totalWeight = 0;
    for (let i = 0; i < recent.length; i++) {
        weightedSum += recent[i] * (i + 1);
        totalWeight += (i + 1);
    }
    return parseFloat((weightedSum / totalWeight).toFixed(1));
}

// --- 2. CẬP NHẬT EXPORTS ---
module.exports = { 
    analyzePersonalPattern, 
    predictNextValue,
    db, // Export Realtime Database
    firestore // Export Firestore
};