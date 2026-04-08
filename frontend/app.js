// frontend/app.js

// Import necessary libraries and modules
import { createStore } from 'redux';
import axios from 'axios';

// Initial state for the application
const initialState = {
    data: null,
    loading: false,
    error: null,
};

// Action types
const FETCH_DATA_REQUEST = 'FETCH_DATA_REQUEST';
const FETCH_DATA_SUCCESS = 'FETCH_DATA_SUCCESS';
const FETCH_DATA_FAILURE = 'FETCH_DATA_FAILURE';

// Action creators
const fetchDataRequest = () => ({ type: FETCH_DATA_REQUEST });
const fetchDataSuccess = (data) => ({ type: FETCH_DATA_SUCCESS, payload: data });
const fetchDataFailure = (error) => ({ type: FETCH_DATA_FAILURE, payload: error });

// Reducer function
const reducer = (state = initialState, action) => {
    switch (action.type) {
        case FETCH_DATA_REQUEST:
            return { ...state, loading: true, error: null };
        case FETCH_DATA_SUCCESS:
            return { ...state, loading: false, data: action.payload };
        case FETCH_DATA_FAILURE:
            return { ...state, loading: false, error: action.payload };
        default:
            return state;
    }
};

// Create Redux store
const store = createStore(reducer);

// API handling function
const fetchData = async (url) => {
    store.dispatch(fetchDataRequest());
    try {
        const response = await axios.get(url);
        store.dispatch(fetchDataSuccess(response.data));
    } catch (error) {
        store.dispatch(fetchDataFailure(error.message));
    }
};

// Fetch data example
fetchData('https://api.example.com/data');

// Export the store for use in other parts of the application
export default store;