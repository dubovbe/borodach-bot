import type { Tx } from '../db/client';
import { DomainError, type Id } from '../domain/types';
import type { effectiveOffer } from '../catalog/service';

// One current offer and one identity read supply both the displayed summary and its fingerprint.
// This value is evidence of reviewed terms, never an availability or authorization capability.
export async function reviewedQuote(barberId:Id,serviceIds:Id[],offer:Awaited<ReturnType<typeof effectiveOffer>>,tx:Tx){
  const metadata=(await tx.query<{name:string;address:string;identity:unknown}>(`SELECT b.name,s.address,jsonb_build_object('barberId',b.id,'barberName',b.name,'barberVersion',b.version,'rank',b.rank_id,'shopVersion',s.version,'address',s.address,
    'assignments',(SELECT jsonb_agg(jsonb_build_object('id',a.id,'version',a.version,'service',a.service_id) ORDER BY a.service_id) FROM assignments a WHERE a.barber_id=b.id AND a.service_id=ANY($2::uuid[]))) AS identity
    FROM barbers b CROSS JOIN shop s WHERE b.id=$1 AND b.archived_at IS NULL`,[barberId,serviceIds]))[0];
  if(!metadata)throw new DomainError('offer_unavailable','Мастер недоступен.');
  return {name:metadata.name,address:metadata.address,offer,fingerprint:JSON.stringify({identity:metadata.identity,items:offer.items})};
}
