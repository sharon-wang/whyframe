<template>
  <div id="app">
    <slot />
  </div>
</template>

<style>
*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  background-color: #efefef;
  width: 100%;
  height: 100%;
  padding: 0;
  margin: 0;
}

#app {
  padding: 1rem;
  text-align: center;
}

iframe[data-why] {
  display: inline-block;
  border: none;
  box-shadow: 2.7px 3.2px 3.6px rgba(0, 0, 0, 0.024),
    7.5px 8.8px 10px rgba(0, 0, 0, 0.035),
    18.1px 21.1px 24.1px rgba(0, 0, 0, 0.046),
    60px 70px 80px rgba(0, 0, 0, 0.07);
  border-radius: 0.4rem;
  width: 400px;
  min-height: 200px;
  max-height: 400px;
  background-color: white;
  margin: 0.5rem;
}
</style>
