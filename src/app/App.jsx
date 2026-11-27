import { useEffect } from 'react';
import { Workbench } from '../shell/Workbench.jsx';
import { bootstrap } from './bootstrap.js';

export default function App() {
  useEffect(() => {
    bootstrap();
  }, []);
  return <Workbench />;
}
