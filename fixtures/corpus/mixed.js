export function label(value) {
  let text = '';
  for (const part of String(value).split('')) text += part.toUpperCase();
  return text;
}

export function detail(value) {
  return label(value) + ':' + value.toFixed(2);
}
