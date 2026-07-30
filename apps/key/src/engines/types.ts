export interface NativeBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface NativeTextCharacter {
  value: string;
  bounds?: NativeBounds;
}

export interface NativeTextPage {
  page: number;
  text: string;
  characters: NativeTextCharacter[];
}

export interface NativeLink {
  id: number;
  page: number;
  bounds: NativeBounds;
  target:
    | {
        kind: 'internal';
        page: number;
        xFraction?: number;
        yFraction?: number;
      }
    | {
        kind: 'external';
        url: string;
      };
}

export interface NativeDocumentInfo {
  id: string;
  title?: string;
  pages: Array<{ index: number; width: number; height: number }>;
  toc: Array<{ title: string; page: number; depth: number; destinationY?: number }>;
  links: NativeLink[];
}

export interface NativeSearchMatch {
  page: number;
  start: number;
  end: number;
  preview: string;
  bounds: NativeBounds[];
}

export interface ScientificReference {
  number: number;
  page: number;
  xFraction?: number;
  yFraction?: number;
  text: string;
  textRuns: NativeBounds[];
  metadata?: ScholarlyMetadata;
  metadataError?: string;
}

export interface ScholarlyMetadata {
  source: string;
  sources?: string[];
  title: string;
  abstractText?: string;
  tldrText?: string;
  authors: string[];
  year?: number;
  journal?: string;
  journalShort?: string;
  journalUrl?: string;
  doi?: string;
  openAccess?: boolean;
  fullTextUrl?: string;
  landingUrl?: string;
  certainty?: string;
}

export interface ScientificCitation {
  id: string;
  page: number;
  start: number;
  end: number;
  bounds: NativeBounds;
  source: string;
  numbers: number[];
}

export interface PaperPreprocessingResult {
  document: NativeDocumentInfo;
  isScientific: boolean;
  syntheticLinks: NativeLink[];
  citations: ScientificCitation[];
  references: ScientificReference[];
  signals: {
    referenceEntries: number;
    doiEntries: number;
    bracketCitations: number;
    superscriptCitations: number;
    concentratedInternalLinks: number;
  };
  processingMs: number;
}

export type CompanionStage = 'analyzing' | 'enriching' | 'ready' | 'failed';

export interface NativeCompanionSnapshot {
  generation: number;
  revision: number;
  stage: CompanionStage;
  document: NativeDocumentInfo;
  analysis?: PaperPreprocessingResult;
  hasNativeText: boolean;
  completedReferences: number;
  totalReferences: number;
  error?: string;
}
