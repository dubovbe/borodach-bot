import {expect,it} from 'vitest';
import {staffReason,reportDates,weekDates,safeReportNumber,formatKopecks,staffMonthWindow} from '../../src/reports/input';
it('strict report dates accept the full actual calendar and include Moscow local end day',()=>{
 expect(reportDates('0001-01-01','9999-12-31')).toEqual({from:'0001-01-01',to:'9999-12-31'});
 for(const date of ['0000-01-01','2026-02-29','2026-11-31','2026-1-01','2026-01-01T00:00:00Z'])expect(()=>reportDates(date,date)).toThrow();
 expect(()=>reportDates('2026-11-07','2026-11-06')).toThrow();
 expect(weekDates('2026-11-08')).toEqual({from:'2026-11-02',to:'2026-11-08'});
 expect(weekDates('2026-11-09')).toEqual({from:'2026-11-09',to:'2026-11-15'});
});
it('staff reasons trim meaningful one-line input and reject hidden controls and overlong text',()=>{
 expect(staffReason('  Изменился график  ')).toBe('Изменился график');
 for(const value of ['', ' ', '\nПричина','Причина\nдругая','Причина\u200b','Причина\u2028','а'.repeat(501)])expect(()=>staffReason(value)).toThrow();
 expect(staffReason('а'.repeat(500))).toHaveLength(500);
});
it('report values preserve bigint precision and refuse unsafe numbers',()=>{
 expect(safeReportNumber('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
 for(const value of ['9007199254740992','-1','1.5'])expect(()=>safeReportNumber(value)).toThrow();
 expect(safeReportNumber('0')).toBe(0);
});
it('integer kopeck formatting preserves exact decimal digits including the safe upper boundary',()=>{
 for(const [input,output] of [[0,'0.00'],[1,'0.01'],[100,'1.00'],[90050,'900.50'],[Number.MAX_SAFE_INTEGER,'90071992547409.91']] as const)expect(formatKopecks(input)).toBe(output);
});
it('staff month window covers exactly one Moscow month through its last millisecond',()=>{
 expect(staffMonthWindow('2026-12')).toEqual({from:'2026-12-01T00:00:00+03:00',to:'2026-12-31T20:59:59.999Z'});
 expect(staffMonthWindow('2027-03')).toEqual({from:'2027-03-01T00:00:00+03:00',to:'2027-03-31T20:59:59.999Z'});
 for(const month of ['2026-12','2027-03']){const range=staffMonthWindow(month);expect(Date.parse(range.to)-Date.parse(range.from)).toBe(31*86400000-1);}
});
