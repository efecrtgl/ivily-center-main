import { useEffect, useState } from 'react';
import { appInfo, isTauri } from '../platform/ipc.js';

export default function App() {
  const [info, setInfo] = useState({ name: 'Ivily Center', version: __APP_VERSION__ });

  useEffect(() => {
    if (!isTauri()) return;
    appInfo().then(setInfo).catch(() => {});
  }, []);

  return (
    <main className="boot">
      <h1>{info.name}</h1>
      <p>Version {info.version}</p>
    </main>
  );
}
