// Fixture: every extraction pattern the analyzer must handle
import { collection, collectionGroup, query, where, orderBy, QueryConstraint } from 'firebase/firestore';
declare const db: any, firestore: any, teamId: string, subjectFilter: string[], createdBy: string | undefined;

export const FAN_EDITS_COLLECTION = 'fanEdits';

// 1. Admin: constant collection name
async function adminConstant() {
  return db.collection(FAN_EDITS_COLLECTION).where('teamId', '==', teamId).orderBy('createdAt', 'desc').get();
}

// 2. Admin: template subcollection path
async function adminTemplate(id: string) {
  return db.collection(`teams/${id}/teamPlayers`).where('isCreator', '==', true).orderBy('creationCount', 'desc').get();
}

// 3. Client: constraints.push accumulation
async function clientPush() {
  const constraints: QueryConstraint[] = [where('teamId', '==', teamId), where('deletedAt', '==', null)];
  if (subjectFilter.length > 0) {
    constraints.push(where('subjects', 'array-contains-any', subjectFilter));
  }
  constraints.push(orderBy('createdAt', 'desc'));
  return query(collection(firestore, 'clips'), ...constraints);
}

// 4. Client: inline ternary spread
async function inlineTernary() {
  return query(
    collection(firestore, 'artifacts'),
    where('teamId', '==', teamId),
    ...(createdBy ? [where('createdBy', '==', createdBy)] : []),
    orderBy('createdAt', 'desc'),
  );
}

// 5. Client: multi-arg subcollection + collectionGroup constant
const PLAYER_REWARDS = 'playerRewards';
async function multiArg() {
  const q1 = query(collection(firestore, 'teams', teamId, 'creatorSignups'), where('status', '==', 'pending'), orderBy('createdAt', 'desc'));
  const q2 = query(collectionGroup(firestore, PLAYER_REWARDS), where('date', '==', 'x'), where('status', '==', 'y'));
  return [q1, q2];
}

// 6. Admin: dynamic reassignment with chain
async function dynamicChain(hasFilter: boolean) {
  let ref = db.collection('campaigns').where('teamId', '==', teamId);
  if (hasFilter) ref = ref.where('status', '==', 'active').orderBy('createdAt', 'desc');
  return ref.get();
}
