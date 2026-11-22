import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import { initStore } from './store'

void initStore().then(() => createApp(App).mount('#app'))
