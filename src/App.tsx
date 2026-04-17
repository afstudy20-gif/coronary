import { useState } from 'react';
import CtApp from './CtApp';
import AngioApp from './modalities/angio/AngioApp';

type Modality = 'ct' | 'angio';

export default function App() {
  const [modality, setModality] = useState<Modality | null>(null);

  if (modality === 'ct') {
    return <CtApp onBack={() => setModality(null)} />;
  }
  if (modality === 'angio') {
    return <AngioApp onBack={() => setModality(null)} />;
  }

  return (
    <div className="app-shell modality-picker-shell">
      <div className="modality-picker">
        <div className="modality-picker-header">
          <p className="header-kicker">Coronary Research Suite</p>
          <h1>Select Modality</h1>
          <p className="mini-copy">
            Pick the DICOM modality to analyze. Each path loads its own viewer,
            QCA workflow, and FFR solver.
          </p>
        </div>
        <div className="modality-picker-grid">
          <button className="modality-card" onClick={() => setModality('ct')}>
            <span className="modality-card-tag">CT</span>
            <h2>CCTA — QCA + CT-FFR</h2>
            <p>
              Cardiac CT volume workbench. MPR + cMPR, centerline QCA, plaque
              composition, reduced-order CT-FFR solver.
            </p>
          </button>
          <button className="modality-card" onClick={() => setModality('angio')}>
            <span className="modality-card-tag">XA</span>
            <h2>Angio — QCA + CA-FFR</h2>
            <p>
              Invasive X-ray angiography workbench. Single / multi-frame XA,
              calibrated QCA, vFFR pullback from 2D projections.
            </p>
          </button>
        </div>
      </div>
    </div>
  );
}
