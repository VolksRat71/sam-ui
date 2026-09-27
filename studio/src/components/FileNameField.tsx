// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Every export dialog's "File name" field: prefilled from the video's name,
// editable, and made safe (with its extension) when the file is saved.
type Props = {value: string; onChange: (v: string) => void; disabled?: boolean; hint?: string};

export default function FileNameField({value, onChange, disabled, hint}: Props) {
  return (
    <label className="field">
      <span>File name{hint != null ? ` (${hint})` : ''}</span>
      <input value={value} onChange={e => onChange(e.target.value)} disabled={disabled} spellCheck={false} />
    </label>
  );
}
