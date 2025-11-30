// src/services/mathUtils.js (Đặt trong thư mục services)

/** Tính giá trị trung bình (Mean) */
function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    const sum = arr.reduce((a, b) => a + b, 0);
    return sum / arr.length;
}

/** Tính Độ lệch chuẩn (Standard Deviation - SD) */
function std(arr) {
    if (!arr || arr.length <= 1) return 0;
    const avg = mean(arr);
    const squareDiffs = arr.map(value => {
        const diff = value - avg;
        return diff * diff;
    });
    const avgSquareDiff = mean(squareDiffs);
    return Math.sqrt(avgSquareDiff);
}

module.exports = { mean, std };