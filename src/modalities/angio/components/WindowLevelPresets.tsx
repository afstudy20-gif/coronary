import { useState, useRef, useEffect } from 'react';
import * as cornerstone from '@cornerstonejs/core';

interface Preset {
  name: string;
  window: number;
  level: number;
  description: string;
}

const PRESETS: Preset[] = [
  { name: 'Default', window: 2048, level: 1024, description: 'Standard angio' },
  { name: 'Bright', window: 1500, level: 750, description: 'Bright vessels' },
  { name: 'Dark', window: 3000, level: 1500, description: 'Dark / high contrast' },
  { name: 'Narrow', window: 800, level: 400, description: 'Narrow window' },
  { name: 'Wide', window: 4096, level: 2048, description: 'Wide range' },
];

interface Props {
  renderingEngineId: string;
  viewportId: string;
}

export function WindowLevelPresets({ renderingEngineId, viewportId }: Props) {
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const applyPreset = (preset: Preset) => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;

    const viewport = engine.getViewport(viewportId) as cornerstone.Types.IStackViewport | undefined;
    if (!viewport) return;

    viewport.setProperties({
      voiRange: {
        lower: preset.level - preset.window / 2,
        upper: preset.level + preset.window / 2,
      },
    });
    viewport.render();

    setActivePreset(preset.name);
    setIsOpen(false);
  };

  return (
    <div className="wl-dropdown" ref={dropdownRef}>
      <button
        className={`toolbar-btn ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="Window/Level Presets"
      >
        <span className="tool-label">{activePreset || 'W/L Presets'}</span>
        <span className="wl-arrow">{isOpen ? '\u25B2' : '\u25BC'}</span>
      </button>
      {isOpen && (
        <div className="wl-dropdown-menu">
          {PRESETS.map((preset) => (
            <button
              key={preset.name}
              className={`wl-dropdown-item ${activePreset === preset.name ? 'active' : ''}`}
              onClick={() => applyPreset(preset)}
            >
              <span className="wl-dropdown-name">{preset.name}</span>
              <span className="wl-dropdown-desc">W:{preset.window} L:{preset.level}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
