const DAY_MS = 86400000;
const BEIJING_OFFSET_MS = 8 * 3600000;
const MINUTE_MS = 60000;
export const topicTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export function wholeDayTopicRange(days = 1) {
  return { startDaysAgo: days, startTime: '00:00', endDaysAgo: 0, endTime: '00:00' };
}

function minutes(time) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

export function topicRangeError(range, sendTime) {
  const { startDaysAgo, startTime, endDaysAgo, endTime } = range;
  if ([startDaysAgo, endDaysAgo].some(day => !Number.isSafeInteger(day) || day < 0) ||
      ![startTime, endTime, sendTime].every(time => topicTimePattern.test(time))) {
    return '请输入有效的起止日期和时间';
  }
  if (startDaysAgo < endDaysAgo || (startDaysAgo === endDaysAgo && startTime >= endTime)) {
    return '调研开始时间必须早于结束时间';
  }
  if (endDaysAgo === 0 && endTime > sendTime) return '调研结束时间不能晚于发送时间';
  return '';
}

const localMinute = ms => new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
const localDateStart = date => Date.parse(date + 'T00:00:00+08:00');

function minuteWindow(start, end, reportDate) {
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    display: localMinute(start) + ' 至 ' + localMinute(end) + '（北京时间，结束时间不含）',
    reportDate,
  };
}

export function topicMinuteWindow(now, range) {
  const midnight = localDateStart(localMinute(now.getTime()).slice(0, 10));
  const start = midnight - range.startDaysAgo * DAY_MS + minutes(range.startTime) * MINUTE_MS;
  const end = midnight - range.endDaysAgo * DAY_MS + minutes(range.endTime) * MINUTE_MS;
  if (start < localDateStart('0001-01-01') || end <= start) {
    throw Object.assign(new Error('调研时间范围超出可用日期，请检查起止时间'), { status: 400 });
  }
  return minuteWindow(start, end, localMinute(midnight - DAY_MS).slice(0, 10));
}

export function topicMinuteTitle(window) {
  return window.reportDate + '（' + localMinute(Date.parse(window.start)) + ' 至 ' + localMinute(Date.parse(window.end)) + '）';
}

export function readTopicMinuteTitle(title) {
  const match = /(\d{4}-\d{2}-\d{2})（(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) 至 (\d{4}-\d{2}-\d{2} \d{2}:\d{2})）$/.exec(title);
  if (!match) return;
  const [, reportDate, first, last] = match;
  const start = Date.parse(first.replace(' ', 'T') + ':00+08:00');
  const end = Date.parse(last.replace(' ', 'T') + ':00+08:00');
  if (start < end && Number.isFinite(localDateStart(reportDate))) return minuteWindow(start, end, reportDate);
}
