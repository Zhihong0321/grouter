import { useState, type FormEvent } from "react";
import { api } from "../api/client.js";

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.login(email, password);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    }
  };

  return (
    <div className="container" style={{ maxWidth: 360, marginTop: 80 }}>
      <h2>Reseller Admin</h2>
      <form onSubmit={submit} className="card">
        <div className="form-row">
          <label>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        </div>
        <div className="form-row">
          <label>Password</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
        </div>
        {error && <p style={{ color: "#ff8080" }}>{error}</p>}
        <button type="submit">Log in</button>
      </form>
    </div>
  );
}
