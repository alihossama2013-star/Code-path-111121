import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { EarnedAchievementRecord, getMilestoneSpec } from '../data/milestones';
import { EarnedTokenRecord, getTokenForLesson } from '../data/tokens';
import { sanitizeDateList } from './streak';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

let connectionChecked = false;

export async function testConnection(): Promise<void> {
  if (connectionChecked) return;
  connectionChecked = true;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

export const PROGRESS_EPOCH = 'fresh-2026-11-22-v1';

export type ResumableView = 'landing' | 'roadmap' | 'lesson' | 'playground' | 'stack3d' | 'dashboard';
export type LessonTab = 'learn' | 'practice' | 'assessment';

const RESUMABLE_VIEWS = new Set<ResumableView>([
  'landing',
  'roadmap',
  'lesson',
  'playground',
  'stack3d',
  'dashboard',
]);
const LESSON_TABS = new Set<LessonTab>(['learn', 'practice', 'assessment']);

export interface RemoteProgressPayload {
  completedLessons: string[];
  readLessons: string[];
  passedExercises: string[];
  quizScores: Record<string, number>;
  completionDates: string[];
  progressEpoch?: string | null;
  activeLessonId?: string;
  selectedLanguageId?: string | null;
  lastView?: ResumableView;
  activeLessonTab?: LessonTab;
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function sanitizeSingleId(raw: unknown, maxLen: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length < 1 || raw.length > maxLen) return undefined;
  return VALID_ID_REGEX.test(raw) ? raw : undefined;
}

function sanitizeResumableView(raw: unknown): ResumableView | undefined {
  if (typeof raw !== 'string') return undefined;
  return RESUMABLE_VIEWS.has(raw as ResumableView) ? (raw as ResumableView) : undefined;
}

function sanitizeLessonTab(raw: unknown): LessonTab | undefined {
  if (typeof raw !== 'string') return undefined;
  return LESSON_TABS.has(raw as LessonTab) ? (raw as LessonTab) : undefined;
}

function sanitizeIdList(items: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (
      typeof item === 'string' &&
      item.length >= 1 &&
      item.length <= 64 &&
      VALID_ID_REGEX.test(item) &&
      !seen.has(item)
    ) {
      seen.add(item);
      unique.push(item);
      if (unique.length >= 100) break;
    }
  }
  return unique;
}

function sanitizeScoreMap(scores: Record<string, number>, maxEntries: number): Record<string, number> {
  const result: Record<string, number> = {};
  let count = 0;
  for (const [key, val] of Object.entries(scores)) {
    if (
      typeof key === 'string' &&
      key.length >= 1 &&
      key.length <= 64 &&
      VALID_ID_REGEX.test(key) &&
      typeof val === 'number' &&
      Number.isFinite(val)
    ) {
      result[key] = Math.max(0, Math.min(100, Math.round(val)));
      count += 1;
      if (count >= maxEntries) break;
    }
  }
  return result;
}

function formatEarnedTimestamp(raw: unknown): string | null {
  if (!raw) return null;
  if (raw instanceof Timestamp) {
    return raw.toDate().toISOString();
  }
  if (typeof raw === 'object' && raw !== null && 'toDate' in raw) {
    const maybeDate = (raw as { toDate: () => Date }).toDate();
    return maybeDate instanceof Date ? maybeDate.toISOString() : null;
  }
  if (typeof raw === 'string') return raw;
  return null;
}

export function subscribeUserProgress(
  uid: string,
  onData: (progress: RemoteProgressPayload | null) => void,
  onError: (err: Error) => void
): () => void {
  const path = `users/${uid}`;
  const ref = doc(db, 'users', uid);

  return onSnapshot(
    ref,
    (snapshot) => {
      if (!snapshot.exists()) {
        onData(null);
        return;
      }
      const data = snapshot.data();
      onData({
        completedLessons: Array.isArray(data.completedLessons)
          ? sanitizeIdList(data.completedLessons)
          : [],
        readLessons: Array.isArray(data.readLessons) ? sanitizeIdList(data.readLessons) : [],
        passedExercises: Array.isArray(data.passedExercises)
          ? sanitizeIdList(data.passedExercises)
          : [],
        quizScores:
          data.quizScores && typeof data.quizScores === 'object'
            ? sanitizeScoreMap(data.quizScores as Record<string, number>, 100)
            : {},
        completionDates: Array.isArray(data.completionDates)
          ? sanitizeDateList(data.completionDates)
          : [],
        progressEpoch: typeof data.progressEpoch === 'string' ? data.progressEpoch : null,
        activeLessonId: sanitizeSingleId(data.activeLessonId, 64),
        selectedLanguageId:
          data.selectedLanguageId === null
            ? null
            : sanitizeSingleId(data.selectedLanguageId, 32) ?? null,
        lastView: sanitizeResumableView(data.lastView),
        activeLessonTab: sanitizeLessonTab(data.activeLessonTab),
      });
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export function subscribeEarnedTokens(
  uid: string,
  onData: (tokens: Record<string, EarnedTokenRecord>) => void,
  onError: (err: Error) => void
): () => void {
  const path = `users/${uid}/tokens`;
  const tokensQuery = query(collection(db, 'users', uid, 'tokens'), where('uid', '==', uid));

  return onSnapshot(
    tokensQuery,
    (snapshot) => {
      const map: Record<string, EarnedTokenRecord> = {};
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        const lessonId = typeof data.lessonId === 'string' ? data.lessonId : docSnap.id;
        map[lessonId] = {
          uid: typeof data.uid === 'string' ? data.uid : uid,
          lessonId,
          tokenCode: typeof data.tokenCode === 'string' ? data.tokenCode : 'CP-01',
          languageId: typeof data.languageId === 'string' ? data.languageId : 'html',
          order: typeof data.order === 'number' ? data.order : 1,
          earnedAt: formatEarnedTimestamp(data.earnedAt),
        };
      });
      onData(map);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export function subscribeEarnedAchievements(
  uid: string,
  onData: (achievements: Record<string, EarnedAchievementRecord>) => void,
  onError: (err: Error) => void
): () => void {
  const path = `users/${uid}/achievements`;
  const achQuery = query(collection(db, 'users', uid, 'achievements'), where('uid', '==', uid));

  return onSnapshot(
    achQuery,
    (snapshot) => {
      const map: Record<string, EarnedAchievementRecord> = {};
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        const achievementId =
          typeof data.achievementId === 'string' ? data.achievementId : docSnap.id;
        map[achievementId] = {
          uid: typeof data.uid === 'string' ? data.uid : uid,
          achievementId,
          category:
            typeof data.category === 'string'
              ? (data.category as EarnedAchievementRecord['category'])
              : 'series',
          tier:
            typeof data.tier === 'string'
              ? (data.tier as EarnedAchievementRecord['tier'])
              : 'bronze',
          earnedAt: formatEarnedTimestamp(data.earnedAt),
        };
      });
      onData(map);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function persistProgressAndTokens(
  uid: string,
  progress: RemoteProgressPayload,
  tokensToMint: string[] = [],
  tokensToRevoke: string[] = [],
  achievementsToMint: string[] = []
): Promise<void> {
  if (!uid || !VALID_ID_REGEX.test(uid)) return;

  const userPath = `users/${uid}`;
  const userRef = doc(db, 'users', uid);

  const sanitizedCompleted = sanitizeIdList(progress.completedLessons);
  const sanitizedRead = sanitizeIdList(progress.readLessons);
  const sanitizedExercises = sanitizeIdList(progress.passedExercises);
  const sanitizedScores = sanitizeScoreMap(progress.quizScores, 100);
  const sanitizedDates = sanitizeDateList(progress.completionDates);
  const sanitizedActiveLessonId = sanitizeSingleId(progress.activeLessonId, 64);
  const sanitizedSelectedLangId =
    progress.selectedLanguageId === null
      ? null
      : sanitizeSingleId(progress.selectedLanguageId, 32) ?? null;
  const sanitizedLastView = sanitizeResumableView(progress.lastView);
  const sanitizedLessonTab = sanitizeLessonTab(progress.activeLessonTab);

  try {
    await runTransaction(db, async (tx) => {
      const userSnap = await tx.get(userRef);

      const resumeFields: Record<string, unknown> = {
        selectedLanguageId: sanitizedSelectedLangId,
      };
      if (sanitizedActiveLessonId) {
        resumeFields.activeLessonId = sanitizedActiveLessonId;
      }
      if (sanitizedLastView) {
        resumeFields.lastView = sanitizedLastView;
      }
      if (sanitizedLessonTab) {
        resumeFields.activeLessonTab = sanitizedLessonTab;
      }

      if (!userSnap.exists()) {
        tx.set(userRef, {
          uid,
          completedLessons: sanitizedCompleted,
          readLessons: sanitizedRead,
          passedExercises: sanitizedExercises,
          quizScores: sanitizedScores,
          completionDates: sanitizedDates,
          progressEpoch: PROGRESS_EPOCH,
          ...resumeFields,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        tx.update(userRef, {
          completedLessons: sanitizedCompleted,
          readLessons: sanitizedRead,
          passedExercises: sanitizedExercises,
          quizScores: sanitizedScores,
          completionDates: sanitizedDates,
          progressEpoch: PROGRESS_EPOCH,
          ...resumeFields,
          updatedAt: serverTimestamp(),
        });
      }

      for (const lessonId of tokensToMint) {
        const spec = getTokenForLesson(lessonId);
        if (!spec) continue;
        const tokenRef = doc(db, 'users', uid, 'tokens', lessonId);
        tx.set(tokenRef, {
          uid,
          lessonId: spec.lessonId,
          tokenCode: spec.tokenCode,
          languageId: spec.languageId,
          order: spec.index,
          earnedAt: serverTimestamp(),
        });
      }

      for (const achievementId of achievementsToMint) {
        const spec = getMilestoneSpec(achievementId);
        if (!spec) continue;
        const achRef = doc(db, 'users', uid, 'achievements', achievementId);
        tx.set(achRef, {
          uid,
          achievementId: spec.id,
          category: spec.category,
          tier: spec.tier,
          earnedAt: serverTimestamp(),
        });
      }
    });

    for (const lessonId of tokensToRevoke) {
      if (!VALID_ID_REGEX.test(lessonId)) continue;
      const tokenPath = `users/${uid}/tokens/${lessonId}`;
      try {
        await deleteDoc(doc(db, 'users', uid, 'tokens', lessonId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, tokenPath);
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

export async function clearRemoteProgressAndTokens(
  uid: string,
  knownTokenIds: string[] = [],
  knownAchievementIds: string[] = []
): Promise<void> {
  if (!uid || !VALID_ID_REGEX.test(uid)) return;
  const userPath = `users/${uid}`;
  const tokensPath = `users/${uid}/tokens`;
  const achievementsPath = `users/${uid}/achievements`;

  try {
    const userRef = doc(db, 'users', uid);

    await runTransaction(db, async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists()) {
        tx.set(userRef, {
          uid,
          completedLessons: [],
          readLessons: [],
          passedExercises: [],
          quizScores: {},
          completionDates: [],
          progressEpoch: PROGRESS_EPOCH,
          activeLessonId: 'html-1-intro',
          selectedLanguageId: null,
          lastView: 'roadmap',
          activeLessonTab: 'learn',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        tx.update(userRef, {
          completedLessons: [],
          readLessons: [],
          passedExercises: [],
          quizScores: {},
          completionDates: [],
          progressEpoch: PROGRESS_EPOCH,
          activeLessonId: 'html-1-intro',
          selectedLanguageId: null,
          lastView: 'roadmap',
          activeLessonTab: 'learn',
          updatedAt: serverTimestamp(),
        });
      }
    });

    const tokenIdsToDelete = new Set<string>();
    for (const id of knownTokenIds) {
      if (typeof id === 'string' && VALID_ID_REGEX.test(id)) {
        tokenIdsToDelete.add(id);
      }
    }

    try {
      const tokensQuery = query(collection(db, 'users', uid, 'tokens'), where('uid', '==', uid));
      const tokensSnapshot = await getDocs(tokensQuery);
      tokensSnapshot.forEach((docSnap) => {
        if (VALID_ID_REGEX.test(docSnap.id)) {
          tokenIdsToDelete.add(docSnap.id);
        }
      });
    } catch (listError) {
      handleFirestoreError(listError, OperationType.LIST, tokensPath);
    }

    const tokenIds = Array.from(tokenIdsToDelete);
    for (let i = 0; i < tokenIds.length; i += 400) {
      const chunk = tokenIds.slice(i, i + 400);
      const batch = writeBatch(db);
      for (const tokenId of chunk) {
        batch.delete(doc(db, 'users', uid, 'tokens', tokenId));
      }
      await batch.commit();
    }

    const achievementIdsToDelete = new Set<string>();
    for (const id of knownAchievementIds) {
      if (typeof id === 'string' && VALID_ID_REGEX.test(id)) {
        achievementIdsToDelete.add(id);
      }
    }

    try {
      const achQuery = query(
        collection(db, 'users', uid, 'achievements'),
        where('uid', '==', uid)
      );
      const achSnapshot = await getDocs(achQuery);
      achSnapshot.forEach((docSnap) => {
        if (VALID_ID_REGEX.test(docSnap.id)) {
          achievementIdsToDelete.add(docSnap.id);
        }
      });
    } catch (listError) {
      handleFirestoreError(listError, OperationType.LIST, achievementsPath);
    }

    const achIds = Array.from(achievementIdsToDelete);
    for (let i = 0; i < achIds.length; i += 400) {
      const chunk = achIds.slice(i, i + 400);
      const batch = writeBatch(db);
      for (const achId of chunk) {
        batch.delete(doc(db, 'users', uid, 'achievements', achId));
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}
