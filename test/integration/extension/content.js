function mark(n) {
  return n < 2 ? n : mark(n - 1) + mark(n - 2);
}

document.documentElement.dataset.extension = String(mark(16));
