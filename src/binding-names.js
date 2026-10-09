export const hexadecimalName = name => /^[_$]*0x[\da-f]+$/i.test(name);
export const opaqueName = name => hexadecimalName(name) || /^[_$]*[A-Za-z]{1,3}\d*$/.test(name);
