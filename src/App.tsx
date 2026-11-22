import { AnimatePresence, MotionConfig } from 'motion/react';
import { AppProvider, useApp } from './context/AppContext';
import { Navbar } from './components/Navbar';
import { LandingView } from './components/LandingView';
import { RoadmapView } from './components/RoadmapView';
import { LessonView } from './components/LessonView';
import { PlaygroundView } from './components/PlaygroundView';
import { Stack3DView } from './components/Stack3DView';
import { DashboardView } from './components/DashboardView';
import { SignInView } from './components/SignInView';
import { PageReveal } from './components/MotionPrimitives';
import { ErrorBoundary } from './components/ErrorBoundary';

function AppShell() {
  const { view, t, user, authLoading, progressReady } = useApp();

  if (authLoading || (user && !progressReady)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white text-[#111111] dark:bg-[#111111] dark:text-white">
        <span className="font-mono text-xs text-[#777777] dark:text-[#A3A3A3]">
          {user ? t.auth.loadingWorkspace : 'CodePath...'}
        </span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col bg-white text-[#111111] transition-colors duration-150 dark:bg-[#111111] dark:text-white">
        <Navbar />
        <main className="flex-1">
          <PageReveal>
            <SignInView />
          </PageReveal>
        </main>
        <footer className="border-t border-[#E7E7E7] bg-white py-6 dark:border-[#262626] dark:bg-[#111111]">
          <div className="mx-auto flex max-w-[1280px] flex-col items-center justify-between gap-2 px-4 text-xs text-[#777777] sm:flex-row sm:px-6 lg:px-8 dark:text-[#A3A3A3]">
            <span>{t.footer.copyright}</span>
            <span>{t.footer.builtFor}</span>
          </div>
        </footer>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-white text-[#111111] transition-colors duration-150 dark:bg-[#111111] dark:text-white">
      <Navbar />

      <main className="flex-1">
        <AnimatePresence mode="wait">
          <PageReveal key={view}>
            {view === 'landing' && <LandingView />}
            {view === 'roadmap' && <RoadmapView />}
            {view === 'lesson' && <LessonView />}
            {view === 'playground' && <PlaygroundView />}
            {view === 'stack3d' && <Stack3DView />}
            {view === 'dashboard' && <DashboardView />}
            {view === 'signin' && <SignInView />}
          </PageReveal>
        </AnimatePresence>
      </main>

      {view !== 'stack3d' && (
        <footer className="border-t border-[#E7E7E7] bg-white py-8 dark:border-[#262626] dark:bg-[#111111]">
          <div className="mx-auto flex max-w-[1280px] flex-col items-center justify-between gap-2 px-4 text-xs text-[#777777] sm:flex-row sm:px-6 lg:px-8 dark:text-[#A3A3A3]">
            <span>{t.footer.copyright}</span>
            <span>{t.footer.builtFor}</span>
          </div>
        </footer>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <MotionConfig reducedMotion="user">
        <AppProvider>
          <AppShell />
        </AppProvider>
      </MotionConfig>
    </ErrorBoundary>
  );
}
