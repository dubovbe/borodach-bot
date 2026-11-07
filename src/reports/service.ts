import type {Database,SqlReader} from '../db/client';
import {DomainError,type Actor} from '../domain/types';
import {reportDates,safeReportNumber} from './input';
export type ReportInput={fromLocalDate:string;toLocalDate:string;barberId?:string};
export async function readReport(actor:Actor,input:ReportInput,sql:SqlReader){
 const dates=reportDates(input.fromLocalDate,input.toLocalDate);
 const row=(await sql.query<{allowed:boolean;completed:string;no_shows:string;value:string}>(`WITH actor AS (
  SELECT u.id,EXISTS(SELECT 1 FROM roles WHERE user_id=u.id AND role='admin') AS admin,
   EXISTS(SELECT 1 FROM roles WHERE user_id=u.id AND role='barber') AS barber,
   (SELECT id FROM barbers WHERE user_id=u.id) AS own FROM telegram_users u WHERE telegram_id=$1
 ), authority AS (SELECT *,admin OR (barber AND own IS NOT NULL AND ($2::text IS NULL OR own::text=$2)) AS allowed FROM actor),
 eligible AS (SELECT v.id,v.status FROM visits v CROSS JOIN authority a WHERE a.allowed
  AND (CASE WHEN a.admin THEN ($2::text IS NULL OR v.barber_id::text=$2) ELSE v.barber_id=a.own END)
  AND v.start_at>=($3::date::timestamp AT TIME ZONE 'Europe/Moscow')
  AND v.start_at<(($4::date+1)::timestamp AT TIME ZONE 'Europe/Moscow'))
 SELECT COALESCE((SELECT allowed FROM authority),false) AS allowed,
  (SELECT count(*) FROM eligible WHERE status='completed')::text AS completed,
  (SELECT count(*) FROM eligible WHERE status='no_show')::text AS no_shows,
  COALESCE((SELECT sum(i.price_kopecks::bigint) FROM eligible v JOIN visit_items i ON i.visit_id=v.id WHERE v.status='completed'),0)::text AS value`,[actor.telegramId,input.barberId??null,dates.from,dates.to]))[0];
 if(!row?.allowed)throw new DomainError('forbidden','Отчёт недоступен.');
 return {completed:safeReportNumber(row.completed),noShows:safeReportNumber(row.no_shows),serviceValueKopecks:safeReportNumber(row.value)};
}
export async function getReport(actor:Actor,input:ReportInput,db:Database){return db.read(sql=>readReport(actor,input,sql));}
