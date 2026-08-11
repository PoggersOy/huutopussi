import { lazy, Suspense, useEffect, useRef } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ConnectionBanner } from './components/ConnectionBanner';
import { RouteSeo } from './components/RouteSeo';
import { Toasts } from './components/Toasts';
import { History } from './screens/History';
import { Home } from './screens/Home';
import { NotFound } from './screens/NotFound';
import { disconnect } from './socket';

const LearnMenu = lazy(() => import('./screens/Learn').then((m) => ({ default: m.LearnMenu })));
const LearnPlay = lazy(() => import('./screens/Learn').then((m) => ({ default: m.LearnPlay })));
const PrivacyPolicy = lazy(() =>
  import('./screens/PrivacyPolicy').then((m) => ({ default: m.PrivacyPolicy })),
);
const Profile = lazy(() => import('./screens/Profile').then((m) => ({ default: m.Profile })));
const Room = lazy(() => import('./screens/Room').then((m) => ({ default: m.Room })));
const Rules = lazy(() => import('./screens/Rules').then((m) => ({ default: m.Rules })));

/** Browser Back/gesture navigation must release the singleton room socket. */
function RoomConnectionGuard() {
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);
  useEffect(() => {
    const wasRoom = previousPath.current.startsWith('/r/');
    const isRoom = pathname.startsWith('/r/');
    if (wasRoom && !isRoom) disconnect();
    previousPath.current = pathname;
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <RoomConnectionGuard />
      <RouteSeo />
      <ConnectionBanner />
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/r/:code" element={<Room />} />
          <Route path="/opettele" element={<LearnMenu />} />
          <Route path="/opettele/:id" element={<LearnPlay />} />
          <Route path="/learn" element={<Navigate to="/opettele" replace />} />
          <Route path="/learn/:id" element={<LearnPlay />} />
          <Route path="/history" element={<History />} />
          <Route path="/saannot" element={<Rules />} />
          <Route path="/rules" element={<Navigate to="/saannot" replace />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      <Toasts />
    </BrowserRouter>
  );
}
