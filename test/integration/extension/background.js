function count(n) {
  return n < 2 ? n : count(n - 1) + count(n - 2);
}

console.log(`background ${count(18)}`);
