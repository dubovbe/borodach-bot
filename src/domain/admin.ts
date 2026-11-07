export type MinuteInterval={startMinute:number;endMinute:number};
export type AdminCommand=
 | {kind:'saveService';serviceId:string|null;expectedVersion:number|null;name:string}
 | {kind:'archiveService';serviceId:string;expectedVersion:number}
 | {kind:'saveRank';rankId:string|null;expectedVersion:number|null;name:string}
 | {kind:'archiveRank';rankId:string;expectedVersion:number}
 | {kind:'saveBarber';barberId:string|null;expectedVersion:number|null;name:string;rankId:string|null}
 | {kind:'archiveBarber';barberId:string;expectedVersion:number}
 | {kind:'setRankTariff';rankId:string;serviceId:string;expectedVersion:number;priceKopecks:number;durationMinutes:number}
 | ({kind:'setBarberTariff';barberId:string;serviceId:string;expectedVersion:number}&({operation:'set';priceKopecks:number;durationMinutes:number}|{operation:'reset'}))
 | {kind:'assignBarberService';barberId:string;serviceId:string;expectedVersion:number;assigned:boolean}
 | {kind:'saveWeeklyHours';barberId:string;expectedVersion:number;weekday:number;intervals:MinuteInterval[]}
 | {kind:'saveDateException';barberId:string;expectedVersion:number;date:string;intervals:MinuteInterval[]|null}
 | {kind:'setBookingHorizon';expectedVersion:number;days:number}
 | {kind:'issuePublicLink';barberId:string;expectedVersion:number;replace:boolean}
 | {kind:'showPublicLink';barberId:string;expectedVersion:number};
