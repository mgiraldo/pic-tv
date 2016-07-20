Rails.application.routes.draw do
    root 'constituents#map'

    resources :constituents

    get 'map' => 'constituents#map'
    match 'search' => 'constituents#search', :via => [:get, :post]

end
