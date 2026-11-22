import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { AppView, Language, Theme, translations, Translations } from '../i18n/translations';
import { languages, lessons, PlaygroundStarter, playgroundTemplates } from '../data/curriculum';
import {
  computeQualifiedAchievements,
  EarnedAchievementRecord,
} from '../data/milestones';
import { EarnedTokenRecord, getTokenForLesson } from '../data/tokens';
import { auth, googleProvider } from '../firebase';
import {
  clearRemoteProgressAndTokens,
  LessonTab,
  persistProgressAndTokens,
  PROGRESS_EPOCH,
  RemoteProgressPayload,
  ResumableView,
  subscribeEarnedAchievements,
  subscribeEarnedTokens,
  subscribeUserProgress,
  testConnection,
} from '../utils/firestoreSync';
import {
  calculateStreakStats,
  getLocalDateKey,
  sanitizeDateList,
  StreakStats,
} from '../utils/streak';

interface AppContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  toggleLang: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  t: Translations;
  view: AppView;
  setView: (view: AppView) => void;
  selectedLanguageId: string | null;
  setSelectedLanguageId: (languageId: string | null) => void;
  openLanguage: (languageId: string) => void;
  isLanguageUnlocked: (languageId: string) => boolean;
  activeLessonId: string;
  activeLessonTab: LessonTab;
  setActiveLessonTab: (tab: LessonTab) => void;
  openLesson: (lessonId: string) => void;
  isLessonUnlocked: (lessonId: string) => boolean;
  completedLessons: string[];
  toggleLessonComplete: (lessonId: string) => void;
  markLessonComplete: (lessonId: string) => void;
  readLessons: string[];
  markLessonRead: (lessonId: string) => void;
  isLessonRead: (lessonId: string) => boolean;
  passedExercises: string[];
  markExercisePassed: (lessonId: string) => void;
  isExercisePassed: (lessonId: string) => boolean;
  quizScores: Record<string, number>;
  recordQuizScore: (lessonId: string, scorePercent: number) => void;
  completionDates: string[];
  streakStats: StreakStats;
  earnedTokens: Record<string, EarnedTokenRecord>;
  earnedAchievements: Record<string, EarnedAchievementRecord>;
  playgroundCode: PlaygroundStarter;
  setPlaygroundCode: React.Dispatch<React.SetStateAction<PlaygroundStarter>>;
  savePlaygroundCode: (code?: PlaygroundStarter) => void;
  loadStarterInPlayground: (starter: PlaygroundStarter) => void;
  resetProgress: () => void;
  user: User | null;
  authLoading: boolean;
  progressReady: boolean;
  signInWithGoogle: () => Promise<void>;
  switchGoogleAccount: () => Promise<void>;
  signOutUser: () => Promise<void>;
}

const PREF_STORAGE_KEYS = {
  lang: 'codepath_lang',
  theme: 'codepath_theme',
};

const LEGACY_PROGRESS_KEYS = [
  'codepath_completed_lessons',
  'codepath_read_lessons',
  'codepath_passed_exercises',
  'codepath_quiz_scores',
  'codepath_earned_tokens',
  'codepath_earned_achievements',
  'codepath_game_high_scores',
  'codepath_completion_dates',
  'codepath_playground_code',
  'codepath_progress_epoch',
];

function clearLegacyLocalProgress(): void {
  if (typeof window === 'undefined') return;
  try {
    for (const key of LEGACY_PROGRESS_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

clearLegacyLocalProgress();

function getPlaygroundStorageKey(uid: string): string {
  return `codepath_playground_code_${uid}`;
}

function loadUserPlaygroundCode(uid: string | null | undefined): PlaygroundStarter {
  if (!uid || typeof window === 'undefined') return playgroundTemplates.card;
  try {
    const raw = localStorage.getItem(getPlaygroundStorageKey(uid));
    return raw ? (JSON.parse(raw) as PlaygroundStarter) : playgroundTemplates.card;
  } catch {
    return playgroundTemplates.card;
  }
}

function getInitialViewFromPath(): AppView {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/signin') return 'signin';
  return 'roadmap';
}

function unionUnique(a: string[], b: string[]): string[] {
  const set = new Set<string>([...a, ...b]);
  return Array.from(set);
}

function isLessonUnlockedWith(lessonId: string, doneList: string[]): boolean {
  const idx = lessons.findIndex((l) => l.id === lessonId);
  if (idx < 0) return false;
  if (idx === 0) return true;
  return doneList.includes(lessons[idx - 1].id);
}

function isLanguageUnlockedWith(languageId: string, doneList: string[]): boolean {
  const idx = languages.findIndex((item) => item.id === languageId);
  if (idx < 0) return false;
  if (idx === 0) return true;
  const prevLang = languages[idx - 1];
  const prevLangLessons = lessons.filter((l) => l.languageId === prevLang.id);
  return prevLangLessons.length > 0 && prevLangLessons.every((l) => doneList.includes(l.id));
}

function createEmptyProgress(): RemoteProgressPayload {
  return {
    completedLessons: [],
    readLessons: [],
    passedExercises: [],
    quizScores: {},
    completionDates: [],
    progressEpoch: PROGRESS_EPOCH,
    activeLessonId: lessons[0].id,
    selectedLanguageId: null,
    lastView: 'roadmap',
    activeLessonTab: 'learn',
  };
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    const saved = localStorage.getItem(PREF_STORAGE_KEYS.lang);
    return saved === 'ar' ? 'ar' : 'en';
  });

  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(PREF_STORAGE_KEYS.theme);
    return saved === 'dark' ? 'dark' : 'light';
  });

  const [view, setViewState] = useState<AppView>(getInitialViewFromPath);
  const [selectedLanguageId, setSelectedLanguageIdState] = useState<string | null>(null);
  const [activeLessonId, setActiveLessonId] = useState<string>(lessons[0].id);
  const [activeLessonTab, setActiveLessonTabState] = useState<LessonTab>('learn');
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [progressReady, setProgressReady] = useState<boolean>(false);
  const [asyncError, setAsyncError] = useState<Error | null>(null);

  const [completedLessons, setCompletedLessons] = useState<string[]>([]);
  const [readLessons, setReadLessons] = useState<string[]>([]);
  const [passedExercises, setPassedExercises] = useState<string[]>([]);
  const [quizScores, setQuizScores] = useState<Record<string, number>>({});
  const [earnedTokens, setEarnedTokens] = useState<Record<string, EarnedTokenRecord>>({});
  const [completionDates, setCompletionDates] = useState<string[]>([]);
  const [earnedAchievements, setEarnedAchievements] = useState<
    Record<string, EarnedAchievementRecord>
  >({});

  const [todayKey, setTodayKey] = useState<string>(() => getLocalDateKey());
  const [playgroundCode, setPlaygroundCode] = useState<PlaygroundStarter>(playgroundTemplates.card);

  // Always keep latest progress accessible for non-stale callbacks & Firestore writes
  const progressRef = useRef<RemoteProgressPayload>(createEmptyProgress());
  progressRef.current = {
    completedLessons,
    readLessons,
    passedExercises,
    quizScores,
    completionDates,
    progressEpoch: PROGRESS_EPOCH,
    activeLessonId,
    selectedLanguageId,
    lastView: view === 'signin' ? (progressRef.current.lastView ?? 'roadmap') : view,
    activeLessonTab,
  };

  const earnedTokensRef = useRef<Record<string, EarnedTokenRecord>>(earnedTokens);
  earnedTokensRef.current = earnedTokens;

  const earnedAchievementsRef = useRef<Record<string, EarnedAchievementRecord>>(earnedAchievements);
  earnedAchievementsRef.current = earnedAchievements;

  const activeUidRef = useRef<string | null>(null);
  const initialHydrationDoneRef = useRef<string | null>(null);
  const epochResetInFlightRef = useRef<string | null>(null);
  const navSyncTimerRef = useRef<number | null>(null);

  if (asyncError) {
    throw asyncError;
  }

  const cancelPendingNavSync = () => {
    if (navSyncTimerRef.current !== null) {
      window.clearTimeout(navSyncTimerRef.current);
      navSyncTimerRef.current = null;
    }
  };

  const resetInMemoryProgress = (nextUid?: string | null) => {
    cancelPendingNavSync();
    const empty = createEmptyProgress();
    progressRef.current = empty;
    setCompletedLessons([]);
    setReadLessons([]);
    setPassedExercises([]);
    setQuizScores({});
    setCompletionDates([]);
    setEarnedTokens({});
    setEarnedAchievements({});
    setActiveLessonId(lessons[0].id);
    setActiveLessonTabState('learn');
    setSelectedLanguageIdState(null);
    setPlaygroundCode(loadUserPlaygroundCode(nextUid));
  };

  // Test Firestore connectivity on boot
  useEffect(() => {
    void testConnection();
  }, []);

  // Keep today's local date synced if the tab remains open across midnight
  useEffect(() => {
    const syncDay = () => {
      const next = getLocalDateKey();
      setTodayKey((prev) => (prev === next ? prev : next));
    };
    const intervalId = window.setInterval(syncDay, 60_000);
    window.addEventListener('focus', syncDay);
    document.addEventListener('visibilitychange', syncDay);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', syncDay);
      document.removeEventListener('visibilitychange', syncDay);
    };
  }, []);

  // Listen to Firebase Auth state and enforce strict per-account isolation + /signin gate
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      const nextUid = currentUser?.uid ?? null;
      if (!currentUser) {
        activeUidRef.current = null;
        initialHydrationDoneRef.current = null;
        epochResetInFlightRef.current = null;
        resetInMemoryProgress(null);
        setProgressReady(false);
        setViewState('signin');
        if (window.location.pathname !== '/signin') {
          window.history.replaceState({}, '', '/signin');
        }
      } else if (activeUidRef.current !== nextUid) {
        activeUidRef.current = nextUid;
        initialHydrationDoneRef.current = null;
        epochResetInFlightRef.current = null;
        resetInMemoryProgress(nextUid);
        setProgressReady(false);
      }
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Subscribe to Firestore user progress, earned tokens, and achievements when authenticated
  useEffect(() => {
    if (!user?.uid) return;

    const uid = user.uid;
    activeUidRef.current = uid;
    initialHydrationDoneRef.current = null;
    epochResetInFlightRef.current = null;
    resetInMemoryProgress(uid);
    setProgressReady(false);

    const unsubProgress = subscribeUserProgress(
      uid,
      (remote) => {
        if (activeUidRef.current !== uid) return;

        if (!remote) {
          // Brand new Google account — always start from 0 and initialize its Firestore doc
          const fresh = createEmptyProgress();
          progressRef.current = fresh;
          setCompletedLessons([]);
          setReadLessons([]);
          setPassedExercises([]);
          setQuizScores({});
          setCompletionDates([]);
          setEarnedTokens({});
          setEarnedAchievements({});
          setActiveLessonId(lessons[0].id);
          setActiveLessonTabState('learn');
          setSelectedLanguageIdState(null);
          setViewState('roadmap');
          if (window.location.pathname.replace(/\/+$/, '') === '/signin') {
            window.history.replaceState({}, '', '/');
          }
          initialHydrationDoneRef.current = uid;
          setProgressReady(true);

          void persistProgressAndTokens(uid, fresh, [], [], []).catch((err) => {
            if (activeUidRef.current !== uid) return;
            setAsyncError(err instanceof Error ? err : new Error(String(err)));
          });
          return;
        }

        // One-time account reset for pre-epoch Firestore records
        if (remote.progressEpoch !== PROGRESS_EPOCH) {
          const empty = createEmptyProgress();
          progressRef.current = empty;
          setCompletedLessons([]);
          setReadLessons([]);
          setPassedExercises([]);
          setQuizScores({});
          setCompletionDates([]);
          setEarnedTokens({});
          setEarnedAchievements({});
          setActiveLessonId(lessons[0].id);
          setActiveLessonTabState('learn');
          setSelectedLanguageIdState(null);

          if (epochResetInFlightRef.current !== uid) {
            epochResetInFlightRef.current = uid;
            void clearRemoteProgressAndTokens(uid, remote.completedLessons)
              .then(() => {
                if (activeUidRef.current !== uid) return;
                if (epochResetInFlightRef.current === uid) {
                  epochResetInFlightRef.current = null;
                }
                setViewState('roadmap');
                if (window.location.pathname.replace(/\/+$/, '') === '/signin') {
                  window.history.replaceState({}, '', '/');
                }
                initialHydrationDoneRef.current = uid;
                setProgressReady(true);
              })
              .catch((err) => {
                epochResetInFlightRef.current = null;
                if (activeUidRef.current !== uid) return;
                setAsyncError(err instanceof Error ? err : new Error(String(err)));
              });
          }
          return;
        }

        if (epochResetInFlightRef.current === uid) {
          epochResetInFlightRef.current = null;
        }

        if (initialHydrationDoneRef.current !== uid) {
          initialHydrationDoneRef.current = uid;

          // Returning account: restore exact saved progress and exact stopping point from Firestore
          const firstIncomplete =
            lessons.find((l) => !remote.completedLessons.includes(l.id))?.id ?? lessons[0].id;
          const restoredLessonId =
            remote.activeLessonId &&
            isLessonUnlockedWith(remote.activeLessonId, remote.completedLessons)
              ? remote.activeLessonId
              : firstIncomplete;
          const restoredLessonObj =
            lessons.find((l) => l.id === restoredLessonId) ?? lessons[0];

          let restoredLanguageId: string | null = null;
          if (
            remote.selectedLanguageId &&
            isLanguageUnlockedWith(remote.selectedLanguageId, remote.completedLessons)
          ) {
            restoredLanguageId = remote.selectedLanguageId;
          } else if (remote.lastView === 'lesson') {
            restoredLanguageId = restoredLessonObj.languageId;
          }

          const lessonIsDone = remote.completedLessons.includes(restoredLessonId);
          const lessonIsRead = lessonIsDone || remote.readLessons.includes(restoredLessonId);
          const lessonExPassed =
            lessonIsDone || remote.passedExercises.includes(restoredLessonId);
          let restoredTab: LessonTab = 'learn';
          if (remote.activeLessonTab === 'assessment' && lessonExPassed) {
            restoredTab = 'assessment';
          } else if (remote.activeLessonTab === 'practice' && lessonIsRead) {
            restoredTab = 'practice';
          }

          const restoredView: ResumableView = remote.lastView ?? 'roadmap';

          progressRef.current = {
            completedLessons: remote.completedLessons,
            readLessons: remote.readLessons,
            passedExercises: remote.passedExercises,
            quizScores: remote.quizScores,
            completionDates: remote.completionDates,
            progressEpoch: PROGRESS_EPOCH,
            activeLessonId: restoredLessonId,
            selectedLanguageId: restoredLanguageId,
            lastView: restoredView,
            activeLessonTab: restoredTab,
          };

          setCompletedLessons(remote.completedLessons);
          setReadLessons(remote.readLessons);
          setPassedExercises(remote.passedExercises);
          setQuizScores(remote.quizScores);
          setCompletionDates(remote.completionDates);
          setActiveLessonId(restoredLessonId);
          setSelectedLanguageIdState(restoredLanguageId);
          setActiveLessonTabState(restoredTab);
          setViewState(restoredView);

          if (window.location.pathname.replace(/\/+$/, '') === '/signin') {
            window.history.replaceState({}, '', '/');
          }

          setProgressReady(true);
        } else {
          setCompletedLessons(remote.completedLessons);
          setReadLessons(remote.readLessons);
          setPassedExercises(remote.passedExercises);
          setQuizScores(remote.quizScores);
          setCompletionDates(remote.completionDates);
        }
      },
      (err) => {
        if (activeUidRef.current !== uid) return;
        setAsyncError(err);
      }
    );

    const unsubTokens = subscribeEarnedTokens(
      uid,
      (remoteTokens) => {
        if (activeUidRef.current !== uid) return;
        if (epochResetInFlightRef.current === uid) {
          setEarnedTokens({});
          return;
        }
        setEarnedTokens((prev) => {
          const next = { ...remoteTokens };
          // Ensure any completed lesson missing a Firestore token doc gets minted
          const completed = progressRef.current.completedLessons;
          const missingTokenIds = completed.filter((id) => !remoteTokens[id]);

          if (missingTokenIds.length > 0 && initialHydrationDoneRef.current === uid) {
            for (const lessonId of missingTokenIds) {
              const spec = getTokenForLesson(lessonId);
              if (spec) {
                next[lessonId] = prev[lessonId] ?? {
                  uid,
                  lessonId,
                  tokenCode: spec.tokenCode,
                  languageId: spec.languageId,
                  order: spec.index,
                  earnedAt: new Date().toISOString(),
                };
              }
            }
            void persistProgressAndTokens(uid, progressRef.current, missingTokenIds, []).catch(
              (err) => {
                if (activeUidRef.current !== uid) return;
                setAsyncError(err instanceof Error ? err : new Error(String(err)));
              }
            );
          }

          return next;
        });
      },
      (err) => {
        if (activeUidRef.current !== uid) return;
        setAsyncError(err);
      }
    );

    const unsubAchievements = subscribeEarnedAchievements(
      uid,
      (remoteAchievements) => {
        if (activeUidRef.current !== uid) return;
        if (epochResetInFlightRef.current === uid) {
          setEarnedAchievements({});
          return;
        }
        setEarnedAchievements(remoteAchievements);
      },
      (err) => {
        if (activeUidRef.current !== uid) return;
        setAsyncError(err);
      }
    );

    return () => {
      cancelPendingNavSync();
      unsubProgress();
      unsubTokens();
      unsubAchievements();
    };
  }, [user?.uid]);

  // Sync browser back/forward navigation with /signin route
  useEffect(() => {
    const onPopState = () => {
      if (!auth.currentUser) {
        setViewState('signin');
        return;
      }
      setViewState(getInitialViewFromPath());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const scheduleNavigationSync = () => {
    const uid = user?.uid;
    if (
      !uid ||
      activeUidRef.current !== uid ||
      initialHydrationDoneRef.current !== uid ||
      epochResetInFlightRef.current === uid
    ) {
      return;
    }
    cancelPendingNavSync();
    navSyncTimerRef.current = window.setTimeout(() => {
      navSyncTimerRef.current = null;
      if (
        activeUidRef.current !== uid ||
        initialHydrationDoneRef.current !== uid ||
        epochResetInFlightRef.current === uid
      ) {
        return;
      }
      void persistProgressAndTokens(uid, progressRef.current, [], [], []).catch((err) => {
        if (activeUidRef.current !== uid) return;
        setAsyncError(err instanceof Error ? err : new Error(String(err)));
      });
    }, 0);
  };

  const setView = (nextView: AppView) => {
    if (!auth.currentUser && nextView !== 'signin') {
      setViewState('signin');
      if (window.location.pathname !== '/signin') {
        window.history.pushState({}, '', '/signin');
      }
      return;
    }
    setViewState(nextView);
    if (nextView !== 'signin') {
      progressRef.current = {
        ...progressRef.current,
        lastView: nextView,
      };
      scheduleNavigationSync();
    }
    const targetPath = nextView === 'signin' ? '/signin' : '/';
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
  };

  const setSelectedLanguageId = (languageId: string | null) => {
    setSelectedLanguageIdState(languageId);
    progressRef.current = {
      ...progressRef.current,
      selectedLanguageId: languageId,
    };
    scheduleNavigationSync();
  };

  const setActiveLessonTab = (nextTab: LessonTab) => {
    setActiveLessonTabState(nextTab);
    progressRef.current = {
      ...progressRef.current,
      activeLessonTab: nextTab,
    };
    scheduleNavigationSync();
  };

  // Sync language direction and document lang
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    localStorage.setItem(PREF_STORAGE_KEYS.lang, lang);
  }, [lang]);

  // Sync dark mode class on <html>
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem(PREF_STORAGE_KEYS.theme, theme);
  }, [theme]);

  const streakStats = useMemo(() => {
    void todayKey;
    return calculateStreakStats(completionDates);
  }, [completionDates, todayKey]);

  // Automatically unlock and persist Milestone Achievements when criteria are met (strictly after hydration)
  useEffect(() => {
    const uid = user?.uid;
    if (
      !uid ||
      !progressReady ||
      initialHydrationDoneRef.current !== uid ||
      epochResetInFlightRef.current === uid
    ) {
      return;
    }

    const qualified = computeQualifiedAchievements({
      completedLessons,
      longestStreak: streakStats.longestStreak,
      currentStreak: streakStats.currentStreak,
    });

    const newlyUnlocked = qualified.filter((spec) => !earnedAchievementsRef.current[spec.id]);
    if (newlyUnlocked.length === 0) return;

    const nowIso = new Date().toISOString();
    setEarnedAchievements((prev) => {
      const next = { ...prev };
      for (const spec of newlyUnlocked) {
        if (!next[spec.id]) {
          next[spec.id] = {
            uid,
            achievementId: spec.id,
            category: spec.category,
            tier: spec.tier,
            earnedAt: nowIso,
          };
        }
      }
      return next;
    });

    void persistProgressAndTokens(
      uid,
      progressRef.current,
      [],
      [],
      newlyUnlocked.map((s) => s.id)
    ).catch((err) => {
      if (activeUidRef.current !== uid) return;
      setAsyncError(err instanceof Error ? err : new Error(String(err)));
    });
  }, [
    completedLessons,
    streakStats.longestStreak,
    streakStats.currentStreak,
    user?.uid,
    progressReady,
  ]);

  const setLang = (next: Language) => setLangState(next);
  const toggleLang = () => setLangState((prev) => (prev === 'en' ? 'ar' : 'en'));
  const setTheme = (next: Theme) => setThemeState(next);
  const toggleTheme = () => setThemeState((prev) => (prev === 'light' ? 'dark' : 'light'));

  const isLanguageUnlocked = (languageId: string) =>
    isLanguageUnlockedWith(languageId, completedLessons);

  const openLanguage = (languageId: string) => {
    if (!auth.currentUser) {
      setView('signin');
      return;
    }
    if (!isLanguageUnlocked(languageId)) {
      return;
    }
    setSelectedLanguageIdState(languageId);
    setViewState('roadmap');
    progressRef.current = {
      ...progressRef.current,
      selectedLanguageId: languageId,
      lastView: 'roadmap',
    };
    scheduleNavigationSync();
    if (window.location.pathname !== '/') {
      window.history.pushState({}, '', '/');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const isLessonUnlocked = (lessonId: string) =>
    isLessonUnlockedWith(lessonId, completedLessons);

  const openLesson = (lessonId: string) => {
    if (!auth.currentUser) {
      setView('signin');
      return;
    }
    if (!isLessonUnlocked(lessonId)) {
      return;
    }
    const targetLesson = lessons.find((l) => l.id === lessonId);
    const nextLangId = targetLesson ? targetLesson.languageId : selectedLanguageId;
    const isSameLesson = lessonId === activeLessonId;
    const nextTab: LessonTab = isSameLesson ? activeLessonTab : 'learn';

    if (targetLesson) {
      setSelectedLanguageIdState(targetLesson.languageId);
    }
    setActiveLessonId(lessonId);
    if (!isSameLesson) {
      setActiveLessonTabState('learn');
    }
    setViewState('lesson');
    progressRef.current = {
      ...progressRef.current,
      selectedLanguageId: nextLangId,
      activeLessonId: lessonId,
      activeLessonTab: nextTab,
      lastView: 'lesson',
    };
    scheduleNavigationSync();
    if (window.location.pathname !== '/') {
      window.history.pushState({}, '', '/');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const syncToFirestore = (
    nextProgress: RemoteProgressPayload,
    mintIds: string[] = [],
    revokeIds: string[] = []
  ) => {
    const uid = user?.uid;
    if (
      !uid ||
      activeUidRef.current !== uid ||
      initialHydrationDoneRef.current !== uid ||
      epochResetInFlightRef.current === uid
    ) {
      return;
    }
    cancelPendingNavSync();
    void persistProgressAndTokens(uid, nextProgress, mintIds, revokeIds).catch((err) => {
      if (activeUidRef.current !== uid) return;
      setAsyncError(err instanceof Error ? err : new Error(String(err)));
    });
  };

  const applyLocalTokenMint = (lessonId: string) => {
    const spec = getTokenForLesson(lessonId);
    if (!spec) return;
    setEarnedTokens((prev) => {
      if (prev[lessonId]) return prev;
      return {
        ...prev,
        [lessonId]: {
          uid: user?.uid ?? 'local',
          lessonId,
          tokenCode: spec.tokenCode,
          languageId: spec.languageId,
          order: spec.index,
          earnedAt: new Date().toISOString(),
        },
      };
    });
  };

  const applyLocalTokenRevoke = (lessonId: string) => {
    setEarnedTokens((prev) => {
      if (!prev[lessonId]) return prev;
      const copy = { ...prev };
      delete copy[lessonId];
      return copy;
    });
  };

  const markLessonComplete = (lessonId: string) => {
    const cur = progressRef.current;
    const alreadyDone = cur.completedLessons.includes(lessonId);
    const nextCompleted = alreadyDone ? cur.completedLessons : [...cur.completedLessons, lessonId];
    const currentDayKey = getLocalDateKey();
    const nextDates = !alreadyDone
      ? sanitizeDateList([currentDayKey, ...cur.completionDates])
      : cur.completionDates;
    const nextProgress: RemoteProgressPayload = {
      ...cur,
      completedLessons: nextCompleted,
      completionDates: nextDates,
    };
    progressRef.current = nextProgress;
    setCompletedLessons(nextCompleted);
    if (nextDates !== cur.completionDates) {
      setCompletionDates(nextDates);
    }

    if (!alreadyDone || !earnedTokensRef.current[lessonId]) {
      applyLocalTokenMint(lessonId);
      syncToFirestore(nextProgress, [lessonId], []);
    }
  };

  const toggleLessonComplete = (lessonId: string) => {
    const cur = progressRef.current;
    const isCurrentlyCompleted = cur.completedLessons.includes(lessonId);
    const nextCompleted = isCurrentlyCompleted
      ? cur.completedLessons.filter((id) => id !== lessonId)
      : [...cur.completedLessons, lessonId];
    const currentDayKey = getLocalDateKey();
    const nextDates = !isCurrentlyCompleted
      ? sanitizeDateList([currentDayKey, ...cur.completionDates])
      : cur.completionDates;

    const nextProgress: RemoteProgressPayload = {
      ...cur,
      completedLessons: nextCompleted,
      completionDates: nextDates,
    };
    progressRef.current = nextProgress;
    setCompletedLessons(nextCompleted);
    if (nextDates !== cur.completionDates) {
      setCompletionDates(nextDates);
    }

    if (isCurrentlyCompleted) {
      applyLocalTokenRevoke(lessonId);
      syncToFirestore(nextProgress, [], [lessonId]);
    } else {
      applyLocalTokenMint(lessonId);
      syncToFirestore(nextProgress, [lessonId], []);
    }
  };

  const markLessonRead = (lessonId: string) => {
    const cur = progressRef.current;
    if (cur.readLessons.includes(lessonId)) return;
    const nextRead = [...cur.readLessons, lessonId];
    const nextProgress: RemoteProgressPayload = { ...cur, readLessons: nextRead };
    progressRef.current = nextProgress;
    setReadLessons(nextRead);
    syncToFirestore(nextProgress);
  };

  const isLessonRead = (lessonId: string) =>
    readLessons.includes(lessonId) || completedLessons.includes(lessonId);

  const markExercisePassed = (lessonId: string) => {
    const cur = progressRef.current;
    if (cur.passedExercises.includes(lessonId)) return;
    const nextExercises = [...cur.passedExercises, lessonId];
    const nextProgress: RemoteProgressPayload = { ...cur, passedExercises: nextExercises };
    progressRef.current = nextProgress;
    setPassedExercises(nextExercises);
    syncToFirestore(nextProgress);
  };

  const isExercisePassed = (lessonId: string) =>
    passedExercises.includes(lessonId) || completedLessons.includes(lessonId);

  const recordQuizScore = (lessonId: string, scorePercent: number) => {
    const cur = progressRef.current;
    const nextScores: Record<string, number> = {
      ...cur.quizScores,
      [lessonId]: Math.max(cur.quizScores[lessonId] ?? 0, scorePercent),
    };
    const shouldComplete = scorePercent >= 70 && !cur.completedLessons.includes(lessonId);
    const nextCompleted = shouldComplete
      ? [...cur.completedLessons, lessonId]
      : cur.completedLessons;
    const currentDayKey = getLocalDateKey();
    const nextDates = shouldComplete
      ? sanitizeDateList([currentDayKey, ...cur.completionDates])
      : cur.completionDates;

    const nextProgress: RemoteProgressPayload = {
      ...cur,
      quizScores: nextScores,
      completedLessons: nextCompleted,
      completionDates: nextDates,
    };
    progressRef.current = nextProgress;
    setQuizScores(nextScores);
    if (shouldComplete) {
      setCompletedLessons(nextCompleted);
      setCompletionDates(nextDates);
      applyLocalTokenMint(lessonId);
      syncToFirestore(nextProgress, [lessonId], []);
    } else {
      syncToFirestore(nextProgress);
    }
  };

  const savePlaygroundCode = (codeToSave?: PlaygroundStarter) => {
    const uid = user?.uid;
    if (!uid) return;
    const payload = codeToSave ?? playgroundCode;
    try {
      localStorage.setItem(getPlaygroundStorageKey(uid), JSON.stringify(payload));
    } catch {
      // Ignore storage errors
    }
  };

  const loadStarterInPlayground = (starter: PlaygroundStarter) => {
    if (!auth.currentUser) {
      setView('signin');
      return;
    }
    setPlaygroundCode(starter);
    savePlaygroundCode(starter);
    setView('playground');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const resetProgress = () => {
    cancelPendingNavSync();
    const knownTokenIds = unionUnique(
      progressRef.current.completedLessons,
      Object.keys(earnedTokensRef.current)
    );
    const knownAchievementIds = Object.keys(earnedAchievementsRef.current);
    const emptyProgress = createEmptyProgress();
    progressRef.current = emptyProgress;
    setCompletedLessons([]);
    setReadLessons([]);
    setPassedExercises([]);
    setQuizScores({});
    setCompletionDates([]);
    setEarnedTokens({});
    setEarnedAchievements({});
    setActiveLessonId(lessons[0].id);
    setActiveLessonTabState('learn');
    setSelectedLanguageIdState(null);

    const uid = user?.uid;
    if (uid) {
      try {
        localStorage.removeItem(getPlaygroundStorageKey(uid));
      } catch {
        // Ignore storage errors
      }
      setPlaygroundCode(playgroundTemplates.card);

      void clearRemoteProgressAndTokens(uid, knownTokenIds, knownAchievementIds).catch((err) => {
        if (activeUidRef.current !== uid) return;
        setAsyncError(err instanceof Error ? err : new Error(String(err)));
      });
    }
  };

  const signInWithGoogle = async () => {
    await signInWithPopup(auth, googleProvider);
  };

  const switchGoogleAccount = async () => {
    cancelPendingNavSync();
    await signInWithPopup(auth, googleProvider);
  };

  const signOutUser = async () => {
    cancelPendingNavSync();
    await signOut(auth);
  };

  return (
    <AppContext.Provider
      value={{
        lang,
        setLang,
        toggleLang,
        theme,
        setTheme,
        toggleTheme,
        t: translations[lang],
        view,
        setView,
        selectedLanguageId,
        setSelectedLanguageId,
        openLanguage,
        isLanguageUnlocked,
        activeLessonId,
        activeLessonTab,
        setActiveLessonTab,
        openLesson,
        isLessonUnlocked,
        completedLessons,
        toggleLessonComplete,
        markLessonComplete,
        readLessons,
        markLessonRead,
        isLessonRead,
        passedExercises,
        markExercisePassed,
        isExercisePassed,
        quizScores,
        recordQuizScore,
        completionDates,
        streakStats,
        earnedTokens,
        earnedAchievements,
        playgroundCode,
        setPlaygroundCode,
        savePlaygroundCode,
        loadStarterInPlayground,
        resetProgress,
        user,
        authLoading,
        progressReady,
        signInWithGoogle,
        switchGoogleAccount,
        signOutUser,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
