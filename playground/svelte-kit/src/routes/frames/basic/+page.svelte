<script>
  import { createApp } from 'whyframe:app'
  import './style.css'

  /**
   * @param {HTMLElement} node
   */
  function app(node) {
    createApp(node)
  }
</script>

<div use:app />
