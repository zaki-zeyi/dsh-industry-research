import React, { useState } from 'react';

export function ChoiceGroup({ title, values, selected, onChange, onAdd }) {
 const [custom, setCustom] = useState('');
 return <fieldset className="industry-choices"><legend>{title}<button type="button" onClick={() => onChange(selected.length === values.length ? [] : values)}>{selected.length === values.length ? '清空' : '全选'}</button></legend><div>{values.map(v => <label key={v}><input type="checkbox" checked={selected.includes(v)} onChange={e => onChange(e.target.checked ? [...selected,v] : selected.filter(x => x !== v))}/>{v}</label>)}</div><div className="industry-add"><input aria-label={'自定义' + title} maxLength={120} placeholder={'添加自定义' + title} value={custom} onChange={e => setCustom(e.target.value)}/><button type="button" disabled={!custom.trim()} onClick={async () => { if (await onAdd(custom.trim())) setCustom(''); }}>＋ 添加</button></div></fieldset>;
}
