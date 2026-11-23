import { palettes, type Appearance, type ThemeColors } from '@openpane/theme';
import { ThemeScope } from '@openpane/ui-primitives/desktop';
import { BuiltinColors } from './BuiltinColors.js';
import { Suspense, type ReactNode } from 'react';
import type { ConversationContentLayoutProps } from '@openpane/sdk/react';
import { CustomizationBoundary, type ContentLayoutSelection } from './DesktopCustomizations.js';

export function CustomizationContent({ contentPalette = palettes, selection, conversationKey, transcript, nativeTranscript, modules, before = null, after = null }: ConversationContentLayoutProps & {
  readonly contentPalette?: Readonly<Record<Appearance, ThemeColors>>;
  readonly selection: ContentLayoutSelection;
  readonly conversationKey: string;
  readonly nativeTranscript: ReactNode;
  /** Shown first inside the same scroll area, outside any claimed layout. */
  readonly before?: ReactNode;
  /** App-owned cards remain outside all replaceable content. */
  readonly after?: ReactNode;
}) {
  const fallback = <>{transcript}{modules}</>;
  let content = fallback;
  if (selection.kind === 'missing') {
    content = <><BuiltinColors><p role="alert">Selected {selection.namespace} layout is unavailable. The default arrangement remains active.</p></BuiltinColors>{fallback}</>;
  } else if (selection.kind === 'conflict') {
    content = <><BuiltinColors><p role="alert">Content layout conflict. {selection.namespaces.join(', ')} claim the layout. The default arrangement remains active.</p></BuiltinColors>{fallback}</>;
  } else if (selection.kind === 'claimed') {
    const Layout = selection.owner.presentation.contentLayout;
    content = <Suspense fallback={<><BuiltinColors><p data-openpane-part="status" role="status">Content layout is loading. Module actions will return when it is ready.</p></BuiltinColors>{nativeTranscript}</>}>
      <CustomizationBoundary key={`${selection.owner.lifetime}/${conversationKey}`} fail={selection.owner.fail} fallback={nativeTranscript}>
        <Layout transcript={transcript} modules={modules} />
      </CustomizationBoundary>
    </Suspense>;
  }
  return <ThemeScope data-openpane-part="transcript-surface" className="conversation-content" palette={contentPalette}>{before}{content}{after}</ThemeScope>;
}
