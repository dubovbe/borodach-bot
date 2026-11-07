import {expect,it} from 'vitest';
import {parseRoubles,parseMinutes,parseIntervals,parseName,parseHorizon,parseDate} from '../../src/bot/admin-input';
it('parses exact rubles without rounding and rejects invalid or overflowing amounts',()=>{expect(parseRoubles(' 21474836,47 ')).toBe(2147483647);expect(parseRoubles('0')).toBe(0);expect(parseRoubles('15.1')).toBe(1510);for(const x of ['-1','1.001','21474836.48','1e2','1,2.3','Infinity',''])expect(()=>parseRoubles(x)).toThrow();});
it('accepts positive int32 minutes without capping at a day',()=>{expect(parseMinutes('1441')).toBe(1441);expect(parseMinutes('2147483647')).toBe(2147483647);for(const x of ['0','-1','1.5','2147483648','1e2',''])expect(()=>parseMinutes(x)).toThrow();});
it('parses working intervals with gaps and rejects overlap reversal and invalid clock',()=>{expect(parseIntervals('09:00–12:00, 13:00-24:00')).toEqual([{startMinute:540,endMinute:720},{startMinute:780,endMinute:1440}]);for(const x of ['12:00-09:00','09:00-12:00,11:00-13:00','24:00-24:00','09:60-12:00','','09:00-25:00'])expect(()=>parseIntervals(x)).toThrow();});
it('validates meaningful names real dates and booking horizon bounds',()=>{expect(parseName(' Анна ')).toBe('Анна');expect(parseDate('2028-02-29')).toBe('2028-02-29');expect(parseHorizon('365')).toBe(365);for(const x of ['', 'a\nb','a'.repeat(81)])expect(()=>parseName(x)).toThrow();for(const x of ['2026-02-29','2026-13-01','2026-2-01'])expect(()=>parseDate(x)).toThrow();for(const x of ['0','366','1.5'])expect(()=>parseHorizon(x)).toThrow();});
import {validateSchedule} from '../../src/schedule/service';
import {DomainError,type WorkSchedule} from '../../src/domain/types';
it('invalid calendar years and malformed schedule intervals fail with controlled errors',()=>{
 expect(()=>parseDate('0000-01-01')).toThrow(DomainError);
 for(const weekly of [{1:null},{1:[null]},{1:[{startMinute:NaN,endMinute:60}]}])expect(()=>validateSchedule({timezone:'Europe/Moscow',weekly,exceptions:{}} as unknown as WorkSchedule)).toThrow(DomainError);
});
