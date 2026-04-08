// frontend/script.js

// Function to switch pages in the application
function switchPage(pageId) {
    const pages = document.querySelectorAll('.page');
    pages.forEach(page => {
        page.style.display = (page.id === pageId) ? 'block' : 'none';
    });
}

// Function to set the currency displayed in the application
function setCurrency(currency) {
    const currencyDisplay = document.getElementById('currency-display');
    currencyDisplay.textContent = currency;
}

// Function to open the login modal
function openLoginModal() {
    const modal = document.getElementById('login-modal');
    modal.style.display = 'block';
}

// Function to filter the list of servers based on a search term
function filterServers(searchTerm) {
    const servers = document.querySelectorAll('.server');
    servers.forEach(server => {
        const serverName = server.querySelector('.server-name').textContent;
        server.style.display = serverName.includes(searchTerm) ? 'block' : 'none';
    });
}

// Placeholder for any other referenced functions
function otherFunction() {
    // implementation for other referenced functions
}