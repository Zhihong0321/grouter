import { useEffect, useState } from "react";
import { Routes, Route, Navigate, Link, useNavigate } from "react-router-dom";
import { api } from "./api/client.js";
import LoginPage from "./pages/LoginPage.js";
import KeysListPage from "./pages/KeysListPage.js";
import KeyDetailPage from "./pages/KeyDetailPage.js";
import PriceTablePage from "./pages/PriceTablePage.js";
import SettingsPage from "./pages/SettingsPage.js";

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.me().then(() => setAuthed(true)).catch(() => setAuthed(false));
  }, []);

  if (authed === null) return null;

  if (!authed) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage onLogin={() => setAuthed(true)} />} />
      </Routes>
    );
  }

  const logout = async () => {
    await api.logout();
    setAuthed(false);
    navigate("/");
  };

  return (
    <>
      <nav className="nav">
        <Link to="/keys">Keys</Link>
        <Link to="/prices">Prices</Link>
        <Link to="/settings">Settings</Link>
        <span style={{ marginLeft: "auto" }}>
          <button className="secondary" onClick={logout}>Log out</button>
        </span>
      </nav>
      <div className="container">
        <Routes>
          <Route path="/" element={<Navigate to="/keys" replace />} />
          <Route path="/keys" element={<KeysListPage />} />
          <Route path="/keys/:id" element={<KeyDetailPage />} />
          <Route path="/prices" element={<PriceTablePage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </>
  );
}
