"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.todayIso = todayIso;
exports.isoDay = isoDay;
exports.daysAgo = daysAgo;
exports.dayRange = dayRange;
exports.parseDate = parseDate;
/** Dzien w UTC jako "RRRR-MM-DD" - format kolumn DATE w MySQL. */
function todayIso(offsetDays = 0) {
    const now = new Date();
    now.setUTCDate(now.getUTCDate() + offsetDays);
    return now.toISOString().slice(0, 10);
}
function isoDay(value) {
    return value.toISOString().slice(0, 10);
}
function daysAgo(days) {
    return new Date(Date.now() - days * 86_400_000);
}
/** Lista kolejnych dni od najstarszego do dzisiejszego, wlacznie. */
function dayRange(days) {
    return Array.from({ length: days }, (_, i) => todayIso(-(days - 1 - i)));
}
function parseDate(value) {
    if (!value)
        return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
//# sourceMappingURL=dates.js.map