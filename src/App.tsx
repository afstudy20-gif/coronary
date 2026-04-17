import { useState } from 'react';
import CtApp from './CtApp';
import AngioApp from './modalities/angio/AngioApp';

type Modality = 'ct' | 'angio';

export default function App() {
  const [modality, setModality] = useState<Modality | null>(null);
  const [initialFiles, setInitialFiles] = useState<File[] | undefined>(undefined);

  function pickFiles(mode: Modality, folder: boolean) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) {
      (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
    }
    input.onchange = (event) => {
      const target = event.target as HTMLInputElement;
      if (target.files?.length) {
        setInitialFiles(Array.from(target.files));
        setModality(mode);
      }
    };
    input.click();
  }

  function handleBack() {
    setModality(null);
    setInitialFiles(undefined);
  }

  if (modality === 'ct') {
    return <CtApp onBack={handleBack} initialFiles={initialFiles} />;
  }
  if (modality === 'angio') {
    return <AngioApp onBack={handleBack} initialFiles={initialFiles} />;
  }

  return (
    <div className="app-shell modality-picker-shell">
      <div className="modality-picker">
        <div className="modality-picker-header">
          <p className="header-kicker">Coronary Research Suite</p>
          <h1>Select Modality</h1>
          <p className="mini-copy">
            Pick the DICOM modality to analyze, then load files or a folder.
            Each path launches its own viewer, QCA workflow, and FFR solver.
          </p>
        </div>
        <div className="modality-picker-grid">
          <div className="modality-card-wrapper">
            <div className="modality-card">
              <span className="modality-card-tag">CT</span>
              <h2>CCTA &mdash; QCA + CT-FFR</h2>
              <p>
                Cardiac CT volume workbench. MPR + cMPR, centerline QCA,
                plaque composition, reduced-order CT-FFR solver.
              </p>
              <div className="modality-card-actions">
                <button className="primary-btn small" onClick={() => pickFiles('ct', false)}>
                  Open Files
                </button>
                <button className="secondary-btn small" onClick={() => pickFiles('ct', true)}>
                  Open Folder
                </button>
                <button
                  className="ghost-btn small"
                  onClick={() => { setInitialFiles(undefined); setModality('ct'); }}
                >
                  Launch empty
                </button>
              </div>
            </div>
          </div>
          <div className="modality-card-wrapper">
            <div className="modality-card">
              <span className="modality-card-tag">XA</span>
              <h2>Angio &mdash; QCA + CA-FFR</h2>
              <p>
                Invasive X-ray angiography workbench. Single / multi-frame XA,
                calibrated QCA, vFFR pullback from 2D projections.
              </p>
              <div className="modality-card-actions">
                <button className="primary-btn small" onClick={() => pickFiles('angio', false)}>
                  Open Files
                </button>
                <button className="secondary-btn small" onClick={() => pickFiles('angio', true)}>
                  Open Folder
                </button>
                <button
                  className="ghost-btn small"
                  onClick={() => { setInitialFiles(undefined); setModality('angio'); }}
                >
                  Launch empty
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
