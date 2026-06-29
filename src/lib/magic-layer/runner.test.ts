import { afterEach, describe, expect, it } from 'vitest';
import { getSam3Profile, isAutoInstallSupported } from './runner';

// getSam3Profile / isAutoInstallSupported branch on process.platform + arch.
// We temporarily override those (restoring after each case) to lock the
// macOS->MLX / Linux->PyTorch routing that the WSL parity work introduced.
const realPlatform = process.platform;
const realArch = process.arch;

function setPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture = 'x64') {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
});

describe('getSam3Profile', () => {
  it('selects the MLX backend on macOS', () => {
    setPlatform('darwin', 'arm64');
    const p = getSam3Profile({} as NodeJS.ProcessEnv);
    expect(p.kind).toBe('mlx');
    expect(p.source).toBe('auto-mlx');
    expect(p.scriptPath).toMatch(/sam3-magic-layer-mlx\.py$/);
    expect(p.editableNoDeps).toBe(true);
  });

  it('selects the PyTorch backend on Linux, installing CUDA torch first', () => {
    setPlatform('linux');
    const p = getSam3Profile({} as NodeJS.ProcessEnv);
    expect(p.kind).toBe('torch');
    expect(p.source).toBe('auto-torch');
    expect(p.scriptPath).toMatch(/sam3-magic-layer-torch\.py$/);
    expect(p.torchIndexDeps).toContain('torch');
    expect(p.torchIndexUrl).toContain('download.pytorch.org');
    expect(p.editableNoDeps).toBe(false);
  });

  it('honours env overrides for the Linux torch source + CUDA index', () => {
    setPlatform('linux');
    const p = getSam3Profile({
      BANANATAPE_SAM3_REPO_URL: 'https://example.com/sam3.git',
      BANANATAPE_TORCH_INDEX_URL: 'https://download.pytorch.org/whl/cu130',
    } as unknown as NodeJS.ProcessEnv);
    expect(p.repoUrl).toBe('https://example.com/sam3.git');
    expect(p.torchIndexUrl).toBe('https://download.pytorch.org/whl/cu130');
  });
});

describe('isAutoInstallSupported', () => {
  it('is true on macOS Apple Silicon and on Linux, false on Windows', () => {
    setPlatform('darwin', 'arm64');
    expect(isAutoInstallSupported({} as NodeJS.ProcessEnv)).toBe(true);
    setPlatform('linux');
    expect(isAutoInstallSupported({} as NodeJS.ProcessEnv)).toBe(true);
    setPlatform('win32');
    expect(isAutoInstallSupported({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is false on Intel macs (no MLX) and when disabled via env', () => {
    setPlatform('darwin', 'x64');
    expect(isAutoInstallSupported({} as NodeJS.ProcessEnv)).toBe(false);
    setPlatform('linux');
    expect(isAutoInstallSupported({ BANANATAPE_DISABLE_AUTO_INSTALL: '1' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});
