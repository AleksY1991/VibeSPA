/** @jsxImportSource @solidjs/web */
import type { JSX } from '@solidjs/web';

export function Icon(props: { readonly name: 'plus' | 'undo' | 'redo' | 'close' | 'check' | 'leaf' }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {props.name === 'plus' && <path d="M12 5v14M5 12h14" />}
      {props.name === 'undo' && <><path d="M8 4 3 9l5 5" /><path d="M3 9h11a7 7 0 0 1 0 14" transform="translate(0 -2)" /></>}
      {props.name === 'redo' && <><path d="m16 4 5 5-5 5" /><path d="M21 9H10a7 7 0 0 0 0 14" transform="translate(0 -2)" /></>}
      {props.name === 'close' && <path d="m7 7 10 10M17 7 7 17" />}
      {props.name === 'check' && <path d="m5 12 4 4L19 6" />}
      {props.name === 'leaf' && <><path d="M19 4C8 3 3 8 5 15c7 3 14-1 14-11Z" /><path d="m4 20 10-10" /></>}
    </svg>
  );
}
