import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ConnectionBanner } from './components/ConnectionBanner';
import { Toasts } from './components/Toasts';
import { Home } from './screens/Home';
import { Room } from './screens/Room';

export default function App() {
  return (
    <BrowserRouter>
      <ConnectionBanner />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/r/:code" element={<Room />} />
      </Routes>
      <Toasts />
    </BrowserRouter>
  );
}
