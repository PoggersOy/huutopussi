import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ConnectionBanner } from './components/ConnectionBanner';
import { Toasts } from './components/Toasts';
import { History } from './screens/History';
import { Home } from './screens/Home';
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
        <Route path="/history" element={<History />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/profile" element={<Profile />} />
      </Routes>
      <Toasts />
    </BrowserRouter>
  );
}
