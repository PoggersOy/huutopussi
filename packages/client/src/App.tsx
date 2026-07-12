import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ConnectionBanner } from './components/ConnectionBanner';
import { Toasts } from './components/Toasts';
import { History } from './screens/History';
import { Home } from './screens/Home';
import { LearnMenu, LearnPlay } from './screens/Learn';
import { PrivacyPolicy } from './screens/PrivacyPolicy';
import { Profile } from './screens/Profile';
import { Room } from './screens/Room';
import { Rules } from './screens/Rules';

export default function App() {
  return (
    <BrowserRouter>
      <ConnectionBanner />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/r/:code" element={<Room />} />
        <Route path="/learn" element={<LearnMenu />} />
        <Route path="/learn/:id" element={<LearnPlay />} />
        <Route path="/history" element={<History />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/profile" element={<Profile />} />
      </Routes>
      <Toasts />
    </BrowserRouter>
  );
}
